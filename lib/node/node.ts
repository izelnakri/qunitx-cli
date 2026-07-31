/**
 * `Node` — Elixir's Node module, JS-shaped: named nodes, connection tracking, monitors,
 * ping — and message passing (`call`/`cast`/`handle`) where BEAM has remote spawns, because
 * JS cannot ship closures across a boundary. The core is transport-agnostic and universal;
 * a {@link Transport} is any frame pipe (the in-process {@link memoryHub} for tests and
 * same-realm clustering, a Worker's message port, a WebSocket adapter).
 *
 * The wire rule from the actor design applies here BY CONSTRUCTION: values cross as
 * structured-clone-safe data, and a `Failure` reply crosses as its `toJSON` envelope and is
 * revived on the caller's side — so a remote handler returning a declared failure lands as
 * a declared failure in the caller's bare union, never a gutted Error.
 *
 * ```ts
 * const hub = memoryHub();
 * const a = Node.start('a@memory', hub.transport());
 * const b = Node.start('b@memory', hub.transport());
 * b.handle('math.add', (payload) => (payload as number[]).reduce((x, y) => x + y, 0));
 * await a.call('b@memory', 'math.add', [20, 22]); // 42 — across "nodes"
 * a.stop();
 * b.stop();
 * ```
 */
import {
  Failure,
  isFailure,
  observed,
  toJSON,
  fromJSON,
  type SerializedFailure,
  type Any as AnyFailure,
} from '../result/failure.ts';
import { Task } from '../task/task.ts';
import { ORSet, type CrdtState, type CausalContext } from './crdt.ts';
import { execute as emit } from '../telemetry/telemetry.ts';

/**
 * A distributed trace context — OpenTelemetry's shape, sized for this wire. Every `call`/`cast`
 * carries one: `id` names the whole request tree, `span` this hop, `parent` the hop that caused
 * it. A handler's nested calls continue the trace automatically (same `id`, `parent` = the
 * incoming span), so a metrics sink attached to the `['node','call','stop']` telemetry event can
 * reassemble cross-node request trees without any app code.
 */
export interface Trace {
  /** The whole request tree — constant across every hop. */
  id: string;
  /** This hop. */
  span: string;
  /** The hop that caused this one (absent at the root). */
  parent?: string;
}

const newSpan = (): string => crypto.randomUUID().slice(0, 8);

/** One frame on the wire. Payloads must be structured-clone-safe; Failures ride `$failure`. */
export type Frame = {
  kind:
    | 'hello'
    | 'bye'
    | 'join'
    | 'leave'
    | 'register'
    | 'unregister'
    | 'crdt'
    | 'sync'
    | 'cast'
    | 'call'
    | 'reply'
    | 'ping'
    | 'pong';
  from: string;
  to?: string;
  /** On a `hello`: whether the sender is a HIDDEN node — attached but not a full member. */
  hidden?: boolean;
  subject?: string;
  /** Process-group name for join/leave frames. */
  group?: string;
  /** Registry name for register/unregister frames. */
  registry?: string;
  /** Registry key for register/unregister frames. */
  key?: string;
  ref?: number;
  payload?: unknown;
  $failure?: SerializedFailure;
  /** CRDT payload for 'crdt' frames (a delta or full state). */
  crdt?: CrdtState;
  /** Whether a 'crdt' frame carries FULL state (anti-entropy) vs a one-op delta. */
  full?: boolean;
  /** A node's causal context for a 'sync' request — the peer replies with what's beyond it. */
  cc?: CausalContext;
  /** The distributed trace this call/cast belongs to — see {@link Trace}. */
  trace?: Trace;
  /** Transport-internal epidemic-gossip envelope (mesh `gossipFanout`): dedup id + hops left. */
  gossip?: { id: string; ttl: number };
  /** Absolute epoch-ms when the ROOT caller gives up — nested calls inherit and never outlive it. */
  deadline?: number;
};

/**
 * The pluggable pipe between nodes: deliver a frame toward its `to` (or everyone, for
 * `hello`/`bye`), and hand inbound frames to the node. Universality lives here — the core
 * never touches a platform API.
 *
 * ```ts
 * const hub = memoryHub();
 * const transport: Transport = hub.transport();
 * typeof transport.send; // 'function'
 * ```
 */
export interface Transport {
  /** Deliver a frame toward `frame.to` (or every peer when `to` is absent). */
  send(frame: Frame): void;
  /** Register the single inbound-frame handler for this node. */
  onFrame(handler: (frame: Frame) => void): void;
  /** Release the pipe (leave the hub, close the port). */
  close?(): void;
  /** Fires after a RE-connection (not the first open) — the node re-announces itself here. */
  onReopen?(cb: () => void): void;
}

/**
 * Which peers {@link NodeHandle.list} returns — Erlang's `Node.list/1` node types. `visible`
 * (default) is connected non-hidden members; `hidden` the attached-but-not-member nodes; `connected`
 * both; `this` just self; `known` self plus every connected peer.
 */
export type NodeListKind = 'visible' | 'hidden' | 'connected' | 'this' | 'known';

/**
 * A running node — Elixir's Node functions as methods, plus the call/cast/handle trio that
 * replaces remote spawns.
 *
 * ```ts
 * const hub = memoryHub();
 * const node = Node.start('worker@memory', hub.transport());
 * node.self(); // 'worker@memory'
 * node.alive(); // true
 * node.stop();
 * node.alive(); // false
 * ```
 */
export interface NodeHandle {
  /** This node's name — Elixir's `Node.self/0`. */
  self(): string;
  /** Whether the node participates in the cluster — Elixir's `Node.alive?/0`. */
  alive(): boolean;
  /**
   * Connected peers — Erlang's `Node.list/0,1`. Defaults to `visible` (non-hidden members); pass a
   * {@link NodeListKind} for `hidden` / `connected` / `this` / `known`. Excludes peers that said bye
   * or went nodedown.
   */
  list(kind?: NodeListKind): string[];
  /** Joins a process group — Elixir's `:pg.join/2` (AP-style: membership gossips, prunes on bye). */
  join(group: string): void;
  /** Leaves a process group. */
  leave(group: string): void;
  /** Current members of a group, self included when joined — `:pg.get_members/1`. */
  groupMembers(group: string): string[];
  /**
   * Claims `key` in `registry` for this node — Elixir's `Registry.register/3` (unique keys).
   * A single owner per key: on a conflict the lexicographically-smallest node name wins, so
   * every node converges on the same owner. Released on bye/nodedown.
   *
   * Distributed registration is OPTIMISTIC (unlike Elixir's local Registry, which rejects a
   * duplicate synchronously — impossible under gossip lag). If a smaller-named node later
   * claims the same key, THIS node loses it and `onConflict` fires — the caller should tear
   * down whatever it was serving under the key (see `serve`'s `via` option, which does this
   * automatically). Callers then re-resolve via {@link NodeHandle.whereis} and retry.
   */
  register(registry: string, key: string, onConflict?: () => void): void;
  /** Releases a key this node owns — Elixir's `Registry.unregister/2`. */
  unregister(registry: string, key: string): void;
  /** The node that owns `key` in `registry`, or `null` — Elixir's `Registry.lookup/2`. */
  whereis(registry: string, key: string): string | null;
  /** Every registered key in `registry` — `Registry.keys`. */
  registered(registry: string): string[];
  /**
   * Add an arbitrary `fact` to the cluster-wide convergent set and gossip it — the low-level
   * primitive that `join`/`register` are conveniences over. A fact converges under frame loss and
   * partition heal (same CRDT + anti-entropy), so higher layers like Presence get distribution for
   * free. The fact string carries whatever structure the caller wants (topic, key, owner, meta).
   */
  putFact(fact: string): void;
  /** Remove a replicated `fact` (observed-remove) and gossip the removal. */
  dropFact(fact: string): void;
  /**
   * Every replicated fact currently present with `prefix` — RAW, with no liveness filter: the
   * caller decides which segment is the owning node and intersects with {@link NodeHandle.list} /
   * {@link NodeHandle.self} to hide facts owned by a downed peer (as the registry does internally).
   */
  facts(prefix: string): string[];
  /** Round-trip liveness — Elixir's `Node.ping/1`: `'pong'` or, after `timeoutMs`, `'pang'`. */
  ping(name: string, timeoutMs?: number): Task<'pong' | 'pang', never>;
  /** Fires `fn(name)` when a peer says bye or its transport drops — Elixir's `Node.monitor/2`. Returns the un-monitor. */
  monitor(fn: (name: string) => void): () => void;
  /**
   * Reports every peer coming UP and going DOWN — Erlang's `:net_kernel.monitor_nodes(true)`
   * (`{nodeup, node}` / `{nodedown, node}`). Unlike {@link NodeHandle.monitor} (down only), this
   * also fires on a first hello and on a reconnect, so membership-driven work — rebalancing a
   * key range onto a newly-joined host, warming a cache — can react to scale-up too. Returns the
   * un-monitor.
   */
  monitorNodes(
    fn: (event: { node: string; status: 'up' | 'down' }) => void,
    options?: { nodeType?: 'visible' | 'hidden' | 'all' },
  ): () => void;
  /** Registers the handler for a subject; the reply (value or Failure) travels back to callers.
   *  `meta.trace` is the incoming {@link Trace} and `meta.deadline` the root caller's absolute
   *  budget — nested calls in the SYNCHRONOUS handler body continue both automatically (a nested
   *  call's timeout is CAPPED at the remaining budget, gRPC-style, so doomed downstream work
   *  stops when the root gives up); async continuations wrap nested calls in
   *  {@link NodeHandle.withTrace}, passing the whole `meta`. */
  handle(
    subject: string,
    handler: (
      payload: unknown,
      from: string,
      meta?: { trace?: Trace; deadline?: number },
    ) => unknown,
  ): void;
  /** The trace of the message currently being handled (synchronous window), if any. */
  trace(): Trace | undefined;
  /** Runs `fn` with the given context ambient — a bare {@link Trace} or a handler's whole `meta`
   *  (trace + deadline) — so nested `call`/`cast` continue it in async handler bodies. */
  withTrace<T>(context: Trace | { trace?: Trace; deadline?: number } | undefined, fn: () => T): T;
  /** Request/response with a deadline. `to` may be a node name, `'group:<name>'` (round-robin
   *  the members — a service), or `'via:<registry>/<key>'` (route to the ONE owner of a key —
   *  an entity). Empty group → declared `NoGroupMembers`; unowned key → `NotRegistered`.
   *  Declared failures cross intact. The send is eager (in flight before the returned Task is
   *  awaited), but the Task is also **retryable**: `.retry(n)` re-runs the whole round-trip —
   *  re-resolving `to` (a group retry can land on a different member) and re-checking the
   *  remaining deadline — so it re-sends, not just re-waits. Retry only calls the caller wants,
   *  since a retried non-idempotent write executes twice. */
  call<T = unknown>(
    to: string,
    subject: string,
    payload?: unknown,
    timeoutMs?: number,
  ): Task<T, AnyFailure>;
  /** Fire-and-forget message — no reply, no deadline. */
  cast(to: string, subject: string, payload?: unknown): void;
  /** Says bye to peers and closes the transport — Elixir's `Node.stop/0`. */
  stop(): void;
  /**
   * Registers a live introspection source under `name` — what `sys.node.info` (and thus an
   * observer dashboard) reports. `genServer()` calls this for you; call it yourself to surface
   * any custom unit. Returns the un-register.
   */
  inspect(name: string, report: () => Record<string, unknown>): () => void;
  /**
   * The names of the units served LOCALLY on this node right now — the local process table (Elixir's
   * `Process.registered/0`). A unit joins on {@link inspect} and leaves when its un-register runs
   * (`genServer` does this on death), so a name here means it is alive on THIS node.
   */
  units(): string[];
  /**
   * The live introspection report for a LOCAL unit (`{ version, mailboxDepth, alive, … }`), or
   * `undefined` if no unit named `name` is served here — the local `Process.whereis/1` lookup.
   */
  unit(name: string): Record<string, unknown> | undefined;
}

/**
 * A liveness watcher shaped exactly like a Supervisor child — Erlang's net ticks. Pings
 * `peer` every `everyMs`; after `missAfter` consecutive pangs it reports the peer down and
 * exits (pair with `restart: 'permanent'` to keep watching forever, `'transient'` to stop
 * once down is reported).
 *
 * ```ts
 * const hub = memoryHub();
 * const watcher = Node.start('watcher@memory', hub.transport());
 * const downs: string[] = [];
 * await heartbeat(watcher, 'ghost@memory', { everyMs: 5, missAfter: 2, onDown: (p) => void downs.push(p) })(
 *   new AbortController().signal,
 * );
 * downs; // ['ghost@memory'] — two missed ticks, reported down
 * watcher.stop();
 * ```
 */
export function heartbeat(
  node: NodeHandle,
  peer: string,
  options: { everyMs?: number; missAfter?: number; onDown: (peer: string) => void },
): (signal: AbortSignal) => Promise<void> {
  const { everyMs = 1000, missAfter = 2, onDown } = options;
  return async (signal) => {
    let misses = 0;
    while (!signal.aborted) {
      const answer = await node.ping(peer, everyMs);
      if (signal.aborted) return;
      if (answer === 'pang') {
        if (++misses >= missAfter) {
          onDown(peer);
          return;
        }
      } else misses = 0;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, everyMs);
        signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
      });
    }
  };
}

/**
 * Starts a named node on a transport — Elixir's `Node.start/3`, minus the runtime flag: in
 * JS, distribution is opt-in per node object, not per VM.
 *
 * ```ts
 * const hub = memoryHub();
 * const left = Node.start('left@memory', hub.transport());
 * const right = Node.start('right@memory', hub.transport());
 * left.list(); // ['right@memory'] — hellos exchanged on start
 * right.list(); // ['left@memory']
 * left.stop();
 * right.stop();
 * ```
 */
export function start(
  name: string,
  transport: Transport,
  options: {
    tick?: { everyMs?: number; missAfter?: number } | false;
    antiEntropyMs?: number | false;
    /**
     * Start as a HIDDEN node — Erlang's `-hidden`. It connects and can observe the cluster
     * (`sys.node.info`, whereis, CRDT state), but peers keep it out of their default `list()`, so it
     * is excluded from rendezvous placement and `:global` — an observer/tooling node that attaches
     * without becoming a member. It still participates in process groups (`:pg`, like Erlang).
     */
    hidden?: boolean;
  } = {},
): NodeHandle {
  const hidden = options.hidden ?? false;
  const peers = new Map<string, { hidden: boolean }>(); // name -> its visibility (Erlang's node table)
  const handlers = new Map<
    string,
    (payload: unknown, from: string, meta?: { trace?: Trace; deadline?: number }) => unknown
  >();
  const monitors = new Set<(name: string) => void>();
  type NodeListener = {
    fn: (event: { node: string; status: 'up' | 'down' }) => void;
    nodeType: 'visible' | 'hidden' | 'all';
  };
  const nodeListeners = new Set<NodeListener>();
  // Fire nodeup/nodedown only to listeners whose node_type matches the peer's visibility — Erlang's
  // `net_kernel:monitor_nodes(Pid, [{node_type, visible|hidden|all}])`; the default is visible-only.
  const notifyNode = (peer: string, peerHidden: boolean, status: 'up' | 'down'): void => {
    for (const listener of nodeListeners)
      if (listener.nodeType === 'all' || (listener.nodeType === 'hidden') === peerHidden)
        listener.fn({ node: peer, status });
  };
  const pending = new Map<number, (frame: Frame) => void>();
  // Membership + registry live in ONE convergent CRDT (ORSet of facts) — a dropped
  // join/register self-heals via anti-entropy, and a healed partition reconciles.
  const crdt = new ORSet(name);
  const myGroups = new Set<string>();
  const roundRobin = new Map<string, number>();
  const myKeys = new Set<string>(); // "registry\u0000key" — what I own
  const conflictHandlers = new Map<string, () => void>(); // rk -> fire when superseded
  const gfact = (group: string, member: string) => `g\u001f${group}\u001f${member}`;
  const rfact = (registry: string, key: string, owner: string) =>
    `r\u001f${registry}\u001f${key}\u001f${owner}`;

  // Liveness (`peers`) is SEPARATE from registrations (`crdt`): reads intersect them, so a
  // nodedown HIDES a peer's entries (routing fails over) without touching the CRDT, and they
  // reappear if it returns — no flapping, no lost registrations on a false nodedown.
  const isLive = (node: string) => node === name || peers.has(node);
  // SECONDARY INDEXES over the CRDT facts, so routing is O(matching entries) — not O(all facts).
  // Every route (`group:`/`via:`), `whereis`, and conflict check reads these instead of scanning
  // the whole replicated fact set. Kept exactly in step with the CRDT by subscribing to its
  // presence transitions — local add/remove AND remote merge/delta all flow through `crdt.onChange`.
  const US = String.fromCharCode(0x1f);
  const groupIndex = new Map<string, Set<string>>(); // group -> members
  const registryIndex = new Map<string, Set<string>>(); // `registry${US}key` -> owners
  const indexFact = (fact: string, present: boolean): void => {
    if (fact.startsWith(`g${US}`)) {
      const rest = fact.slice(2);
      const sep = rest.lastIndexOf(US); // member (a node name) is the LAST segment; the group may
      const group = rest.slice(0, sep); // itself contain U+001F (e.g. pubsub's `pubsub<topic>`)
      const member = rest.slice(sep + 1);
      if (present) {
        let members = groupIndex.get(group);
        if (!members) groupIndex.set(group, (members = new Set()));
        members.add(member);
      } else {
        const members = groupIndex.get(group);
        if (members) {
          members.delete(member);
          if (members.size === 0) {
            groupIndex.delete(group);
            roundRobin.delete(group); // a group emptied — drop its round-robin cursor (no leak)
          }
        }
      }
    } else if (fact.startsWith(`r${US}`)) {
      const rest = fact.slice(2);
      const firstSep = rest.indexOf(US);
      const afterReg = rest.slice(firstSep + 1);
      const lastSep = afterReg.lastIndexOf(US);
      const rk = `${rest.slice(0, firstSep)}${US}${afterReg.slice(0, lastSep)}`;
      const owner = afterReg.slice(lastSep + 1);
      if (present) {
        let owners = registryIndex.get(rk);
        if (!owners) registryIndex.set(rk, (owners = new Set()));
        owners.add(owner);
      } else {
        const owners = registryIndex.get(rk);
        if (owners) {
          owners.delete(owner);
          if (owners.size === 0) registryIndex.delete(rk);
        }
      }
    }
    // Other fact prefixes (e.g. Presence's putFact) aren't indexed here — they read via node.facts().
  };
  crdt.onChange((added, removed) => {
    for (const fact of added) indexFact(fact, true);
    for (const fact of removed) indexFact(fact, false);
  });
  const groupMembersOf = (group: string): string[] => {
    const members = groupIndex.get(group);
    return members ? [...members].filter(isLive) : [];
  };
  const allGroups = (): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const [group, members] of groupIndex) {
      const live = [...members].filter(isLive);
      if (live.length > 0) out[group] = live;
    }
    return out;
  };
  const ownersOf = (registry: string, key: string): string[] => {
    const owners = registryIndex.get(`${registry}${US}${key}`);
    return owners ? [...owners].filter(isLive) : [];
  };

  // Broadcast a one-op CRDT delta (from crdt.add/remove) to every peer — immediate propagation;
  // anti-entropy (full state) backstops any that's dropped.
  const broadcastDelta = (delta: CrdtState): void =>
    transport.send({ kind: 'crdt', from: name, crdt: delta, full: false });

  // After any merge: a key I own may now have a smaller LIVE owner — fire its conflict handler
  // (drives genServer({via}) self-terminate). A partition that elected two owners heals to one.
  const checkConflicts = (): void => {
    for (const rk of [...myKeys]) {
      const [registry, key] = rk.split('\u0000');
      const owners = ownersOf(registry, key);
      const winner = owners.length ? owners.reduce((a, b) => (a < b ? a : b)) : name;
      if (winner !== name) {
        myKeys.delete(rk);
        const onConflict = conflictHandlers.get(rk);
        conflictHandlers.delete(rk);
        onConflict?.();
      }
    }
  };

  // A peer is gone (bye, dropped socket, or net-tick timeout): drop it from liveness — its
  // entries are hidden at once and monitors fire; the CRDT is left intact so it recovers
  // cleanly if it returns.
  const declareDown = (peer: string): void => {
    const wasHidden = peers.get(peer)?.hidden ?? false; // capture visibility before we drop it
    if (peers.delete(peer)) {
      for (const fn of monitors) fn(peer);
      notifyNode(peer, wasHidden, 'down'); // Erlang nodedown, node_type-filtered
    }
  };
  const inspectors = new Map<string, () => Record<string, unknown>>();
  let ref = 0;
  let alive = true;

  // The context of the message being handled RIGHT NOW (synchronous window) — nested call/cast
  // inherit it: the trace threads one correlation id across every hop of a request tree, and the
  // deadline caps every nested timeout so downstream work never outlives the root caller.
  let ambient: { trace?: Trace; deadline?: number } | undefined;
  const childTrace = (): Trace =>
    ambient?.trace
      ? { id: ambient.trace.id, span: newSpan(), parent: ambient.trace.span }
      : { id: crypto.randomUUID(), span: newSpan() };
  const handling = <R>(
    context: { trace?: Trace; deadline?: number } | undefined,
    fn: () => R,
  ): R => {
    const prior = ambient;
    ambient = context;
    try {
      return fn();
    } finally {
      ambient = prior;
    }
  };

  const encode = (value: unknown): Pick<Frame, 'payload' | '$failure'> =>
    isFailure(value) ? { $failure: toJSON(value) } : { payload: value };
  const decode = (frame: Frame): unknown =>
    frame.$failure ? fromJSON(frame.$failure) : frame.payload;

  // Extracted so group-routed frames addressed to SELF can loop back locally — the
  // transport never delivers a node's own sends to itself.
  const receive = (frame: Frame, loopback = false): void => {
    if (
      !alive ||
      (frame.from === name && !loopback) ||
      (frame.to !== undefined && frame.to !== name)
    )
      return;
    if (frame.kind === 'hello') {
      if (!peers.has(frame.from)) {
        const peerHidden = frame.hidden ?? false;
        peers.set(frame.from, { hidden: peerHidden });
        notifyNode(frame.from, peerHidden, 'up'); // Erlang nodeup, node_type-filtered
        transport.send({ kind: 'hello', from: name, to: frame.from, hidden }); // answer + my own visibility
        // Hand the newcomer my full CRDT state — anti-entropy on join, so it converges at once.
        transport.send({
          kind: 'crdt',
          from: name,
          to: frame.from,
          crdt: crdt.state(),
          full: true,
        });
      }
    } else if (frame.kind === 'crdt') {
      // A convergent update: a one-op delta (broadcast) or full state (anti-entropy / hello).
      if (frame.full) crdt.merge(frame.crdt!);
      else crdt.mergeDelta(frame.crdt!);
      checkConflicts();
    } else if (frame.kind === 'sync') {
      // A peer asked what it is missing (its causal context) — reply with full state iff I know
      // anything beyond it (otherwise the sync is a no-op).
      if (crdt.hasBeyond(frame.cc!))
        dispatch({ kind: 'crdt', from: name, to: frame.from, crdt: crdt.state(), full: true });
    } else if (frame.kind === 'bye') {
      declareDown(frame.from);
    } else if (frame.kind === 'ping') {
      dispatch({ kind: 'pong', from: name, to: frame.from, ref: frame.ref });
    } else if (frame.kind === 'pong' || frame.kind === 'reply') {
      pending.get(frame.ref!)?.(frame);
    } else if (frame.kind === 'cast') {
      emit(
        ['node', 'handle'],
        {},
        { subject: frame.subject, from: frame.from, trace: frame.trace },
      );
      const meta = { trace: frame.trace, deadline: frame.deadline };
      handling(meta, () => handlers.get(frame.subject!)?.(decode(frame), frame.from, meta));
    } else if (frame.kind === 'call') {
      // Shed doomed work: a call that arrives PAST its root deadline is answered with the
      // failure the caller already concluded — the handler never runs (gRPC's deadline shed).
      if (frame.deadline !== undefined && Date.now() > frame.deadline) {
        return void dispatch({
          kind: 'reply',
          from: name,
          to: frame.from,
          ref: frame.ref,
          ...encode(
            new Failure('DeadlineExceeded', `${frame.subject} arrived past its deadline`, {
              subject: frame.subject,
            }),
          ),
        });
      }
      const handler = handlers.get(frame.subject!);
      emit(
        ['node', 'handle'],
        {},
        { subject: frame.subject, from: frame.from, trace: frame.trace },
      );
      const meta = { trace: frame.trace, deadline: frame.deadline };
      const outcome = handler
        ? Promise.resolve()
            .then(() => handling(meta, () => handler(decode(frame), frame.from, meta)))
            .catch((thrown: unknown) => {
              // A DECLARED failure a handler throws is routed to the observation seam HERE, at its
              // origin — so a bare `throw SomeFailure()` reaches Failure.onObserved / a trace span
              // without the handler having to `.result()` purely for observability. No-op unless an
              // observer is installed; a bug (non-Failure throw) becomes RemoteCrash, unobserved.
              if (isFailure(thrown)) {
                observed(thrown);
                return thrown;
              }
              return new Failure('RemoteCrash', String(thrown), { subject: frame.subject });
            })
        : Promise.resolve(
            new Failure('NoHandler', `no handler for ${frame.subject} on ${name}`, {
              subject: frame.subject,
            }),
          );
      void outcome.then((value) => {
        const reply: Frame = {
          kind: 'reply',
          from: name,
          to: frame.from,
          ref: frame.ref,
          ...encode(value),
        };
        dispatch(reply);
      });
    }
  };
  transport.onFrame((frame) => receive(frame));
  transport.send({ kind: 'hello', from: name, hidden });

  // The observer protocol — one subject any node (or a browser dashboard node) can call to
  // read this node's live state. Erlang's :observer, reduced to data over the same wire.
  handlers.set('sys.node.info', () => ({
    name,
    peers: [...peers.keys()],
    groups: allGroups(),
    registered: crdt.values().length,
    units: [...inspectors].map(([unit, report]) => ({ name: unit, ...report() })),
  }));

  // Group-aware addressing: 'group:<name>' round-robins the members — call a SERVICE, not a
  // node. A frame addressed to SELF loops back through receive (transports skip own sends).
  const dispatch = (frame: Frame): void => {
    if (frame.to === name) queueMicrotask(() => receive(frame, true));
    else transport.send(frame);
  };
  const resolveTarget = (to: string): { node: string } | { empty: 'group' | 'via' } => {
    if (to.startsWith('group:')) {
      const group = to.slice('group:'.length);
      const members = groupMembersOf(group);
      if (members.length === 0) return { empty: 'group' };
      const at = roundRobin.get(group) ?? 0;
      roundRobin.set(group, at + 1);
      return { node: members[at % members.length] };
    }
    if (to.startsWith('via:')) {
      const slash = to.indexOf('/', 'via:'.length);
      const registry = to.slice('via:'.length, slash);
      const key = to.slice(slash + 1);
      const owners = ownersOf(registry, key);
      if (owners.length === 0) return { empty: 'via' };
      return { node: owners.reduce((a, b) => (a < b ? a : b)) };
    }
    return { node: to };
  };
  // Erlang reconnects re-run the handshake; so do we: a transport that redials (wsTransport
  // with reconnect) re-announces this node, and peers answer hello, rebuilding list().
  transport.onReopen?.(() => {
    transport.send({ kind: 'hello', from: name, hidden });
    // Re-push my full CRDT state after a reconnect so peers re-learn my registrations.
    transport.send({ kind: 'crdt', from: name, crdt: crdt.state(), full: true });
  });

  const awaitRef = <R>(
    timeoutMs: number,
    onReply: (frame: Frame) => R,
    onTimeout: () => R,
  ): Task<R, never> => {
    const id = ++ref;
    const task = new Task<R, never>(
      () =>
        new Promise<R>((resolve, reject) => {
          // The settle paths run inside LATER transport callbacks — a throw there (a revived
          // remote failure, a CallTimeout) must reject THIS task, never escape the transport.
          const settle = (produce: () => R) => {
            try {
              resolve(produce());
            } catch (thrown) {
              reject(thrown);
            }
          };
          const timer = setTimeout(() => {
            pending.delete(id);
            settle(onTimeout);
          }, timeoutMs);
          pending.set(id, (frame) => {
            clearTimeout(timer);
            pending.delete(id);
            settle(() => onReply(frame));
          });
        }),
    );
    return Object.assign(task, { ref: id }) as Task<R, never> & { ref: number };
  };

  const nodeHandle: NodeHandle = {
    self: () => name,
    alive: () => alive,
    list: (kind = 'visible') => {
      if (kind === 'this') return [name];
      if (kind === 'known') return [name, ...peers.keys()];
      const entries = [...peers];
      const wanted =
        kind === 'connected'
          ? entries
          : entries.filter(([, v]) => (kind === 'hidden' ? v.hidden : !v.hidden));
      return wanted.map(([n]) => n);
    },
    join(group) {
      myGroups.add(group);
      broadcastDelta(crdt.add(gfact(group, name)));
    },
    leave(group) {
      myGroups.delete(group);
      broadcastDelta(crdt.remove(gfact(group, name)));
    },
    groupMembers: (group) => groupMembersOf(group),
    register(registry, key, onConflict) {
      const rk = `${registry}\u0000${key}`;
      myKeys.add(rk);
      if (onConflict) conflictHandlers.set(rk, onConflict);
      broadcastDelta(crdt.add(rfact(registry, key, name)));
      checkConflicts();
    },
    unregister(registry, key) {
      const rk = `${registry}\u0000${key}`;
      myKeys.delete(rk);
      conflictHandlers.delete(rk);
      broadcastDelta(crdt.remove(rfact(registry, key, name)));
    },
    whereis: (registry, key) => {
      const owners = ownersOf(registry, key);
      return owners.length ? owners.reduce((a, b) => (a < b ? a : b)) : null;
    },
    registered: (registry) => {
      const prefix = `r\u001f${registry}\u001f`;
      const keys = new Set(
        crdt
          .values()
          .filter((f) => f.startsWith(prefix))
          .map((f) => f.slice(prefix.length, f.indexOf('\u001f', prefix.length))),
      );
      return [...keys];
    },
    putFact: (fact) => broadcastDelta(crdt.add(fact)),
    dropFact: (fact) => broadcastDelta(crdt.remove(fact)),
    facts: (prefix) => crdt.values().filter((f) => f.startsWith(prefix)),
    ping(peer, timeoutMs = 5000) {
      const task = awaitRef<'pong' | 'pang'>(
        timeoutMs,
        () => 'pong',
        () => 'pang',
      ) as Task<'pong' | 'pang', never> & { ref: number };
      transport.send({ kind: 'ping', from: name, to: peer, ref: task.ref });
      return task.perform();
    },
    monitor(fn) {
      monitors.add(fn);
      return () => monitors.delete(fn);
    },
    monitorNodes(fn, options) {
      const listener: NodeListener = { fn, nodeType: options?.nodeType ?? 'visible' };
      nodeListeners.add(listener);
      return () => nodeListeners.delete(listener);
    },
    handle: (subject, handler) => void handlers.set(subject, handler),
    call<T>(to: string, subject: string, payload?: unknown, timeoutMs = 5000) {
      const trace = childTrace();
      const started = performance.now();
      // gRPC-style budget: a nested call never outlives the ROOT caller. The effective timeout
      // is capped at the ambient remaining budget; an already-spent budget fails fast, before
      // the wire — no doomed downstream work.
      const deadline =
        ambient?.deadline !== undefined
          ? Math.min(Date.now() + timeoutMs, ambient.deadline)
          : Date.now() + timeoutMs;
      // The recipe does the WHOLE round-trip — re-resolve the target, allocate a fresh ref, arm
      // the deadline timer, register the reply waiter, dispatch — and RETURNS the deferred reply.
      // Folding the send INTO the recipe (rather than firing it once, outside) is what makes
      // .retry()/.restart() actually re-send: each attempt re-resolves `to` (so a group retry
      // lands on a live member) and re-checks the REMAINING budget (so retries never outlive the
      // deadline). `perform()` below keeps the send eager — the recipe runs, and dispatches, now.
      const task = new Task<T, AnyFailure>(() => {
        const { promise, resolve, reject } = Task.withResolvers<T>();
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          reject(
            new Failure('DeadlineExceeded', `call ${subject} to ${to}: budget already spent`, {
              to,
              subject,
            }),
          );
          return promise;
        }
        const target = resolveTarget(to);
        if ('empty' in target) {
          reject(
            target.empty === 'group'
              ? new Failure('NoGroupMembers', `no members in ${to}`, { group: to })
              : new Failure('NotRegistered', `no owner for ${to}`, { via: to }),
          );
          return promise;
        }
        const id = ++ref;
        const timer = setTimeout(() => {
          pending.delete(id);
          emit(
            ['node', 'call', 'timeout'],
            { duration: performance.now() - started },
            { to, subject, trace },
          );
          reject(
            new Failure(
              'CallTimeout',
              `call ${subject} to ${to} timed out after ${remainingMs}ms`,
              { to, subject },
            ),
          );
        }, remainingMs);
        pending.set(id, (frame) => {
          clearTimeout(timer);
          pending.delete(id);
          emit(
            ['node', 'call', 'stop'],
            { duration: performance.now() - started },
            { to, subject, trace },
          );
          const value = decode(frame);
          if (isFailure(value))
            reject(value); // a remote DECLARED failure stays declared here
          else resolve(value as T);
        });
        emit(['node', 'call', 'start'], {}, { to: target.node, subject, trace });
        dispatch({
          kind: 'call',
          from: name,
          to: target.node,
          subject,
          ref: id,
          trace,
          deadline,
          ...encode(payload),
        });
        return promise;
      });
      task.perform(); // eager send preserved — the recipe runs (and dispatches) NOW
      // Claim the eager reply's rejection. call() is request/response — the returned Task is
      // always consumed (await or .result()) — but a FAST rejection (e.g. an Overloaded shed)
      // can settle before a lazy `.result()` attaches its handler, which would surface as a
      // spurious unhandled rejection. This passive handler marks it handled; the caller's own
      // await/.result() still sees the settlement (a Task memoises to all consumers).
      task.then(undefined, () => {});
      return task;
    },
    trace: () => ambient?.trace,
    withTrace: (context, fn) =>
      handling(context && 'id' in context ? { trace: context } : context, fn),
    inspect(unit, report) {
      inspectors.set(unit, report);
      return () => inspectors.delete(unit);
    },
    units: () => [...inspectors.keys()],
    unit: (name) => inspectors.get(name)?.(),
    cast(to, subject, payload) {
      // A group cast reaches EVERY member (pg-style broadcast); a via: cast reaches the key's
      // owner; a node cast reaches one node.
      let targets: string[];
      if (to.startsWith('group:')) targets = groupMembersOf(to.slice('group:'.length));
      else if (to.startsWith('via:')) {
        const resolved = resolveTarget(to);
        targets = 'node' in resolved ? [resolved.node] : [];
      } else targets = [to];
      const trace = childTrace();
      const deadline = ambient?.deadline; // fire-and-forget still tells downstream when to give up
      for (const target of targets)
        dispatch({
          kind: 'cast',
          from: name,
          to: target,
          subject,
          trace,
          deadline,
          ...encode(payload),
        });
    },
    stop() {
      if (!alive) return;
      alive = false;
      clearInterval(tickTimer);
      clearInterval(syncTimer);
      transport.send({ kind: 'bye', from: name });
      transport.close?.();
    },
  };

  // Erlang's net_ticktime — automatic cluster liveness. Periodically ping every peer; one
  // that misses `missAfter` consecutive ticks is declared DOWN, even if its socket never
  // dropped (an app-level wedge the transport can't see). This is what evicts a "zombie
  // owner" so registry/group routing fails over instead of timing out forever. O(N peers).
  const tick = options.tick;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  if (tick !== false) {
    const everyMs = tick?.everyMs ?? 15000;
    const missAfter = tick?.missAfter ?? 3;
    const misses = new Map<string, number>();
    tickTimer = setInterval(() => {
      for (const peer of [...peers.keys()]) {
        void nodeHandle.ping(peer, everyMs).then((answer) => {
          if (!alive || !peers.has(peer)) return;
          if (answer === 'pong') return void misses.delete(peer);
          const missed = (misses.get(peer) ?? 0) + 1;
          if (missed >= missAfter) (misses.delete(peer), declareDown(peer));
          else misses.set(peer, missed);
        });
      }
    }, everyMs);
    (tickTimer as { unref?: () => void }).unref?.();
  }

  // Anti-entropy — the CRDT convergence backstop. Periodically ask one peer (round-robin) for
  // anything we're missing by sending our version vector; the peer replies with full state iff
  // it holds more. This is what heals a dropped op or a partition, on top of per-op deltas.
  let syncTimer: ReturnType<typeof setInterval> | undefined;
  const antiEntropyMs = options.antiEntropyMs;
  if (antiEntropyMs !== false) {
    let cursor = 0;
    syncTimer = setInterval(() => {
      const list = [...peers.keys()];
      if (list.length === 0) return;
      const peer = list[cursor++ % list.length];
      dispatch({ kind: 'sync', from: name, to: peer, cc: crdt.context() });
    }, antiEntropyMs ?? 10000);
    (syncTimer as { unref?: () => void }).unref?.();
  }

  return nodeHandle;
}

/**
 * An in-process cluster: every `transport()` it hands out is a fully connected peer — the
 * BEAM-in-one-realm arrangement for tests, doctests, and same-tab actor topologies.
 *
 * ```ts
 * const hub = memoryHub();
 * const a = Node.start('a@memory', hub.transport());
 * const b = Node.start('b@memory', hub.transport());
 * const seen: string[] = [];
 * a.monitor((peer) => void seen.push(peer));
 * b.stop();
 * seen; // ['b@memory'] — the monitor fired on bye
 * a.stop();
 * ```
 */
export function memoryHub(): { transport(): Transport } {
  const members = new Set<(frame: Frame) => void>();
  // node name -> its member's deliver fn, learned from each frame's `from`. A frame WITH a `to`
  // routes only there (point-to-point — no O(N) fan-out per call); frames without a `to`
  // (hello/bye/join/register gossip) broadcast; an unknown `to` falls back to broadcast so a
  // pre-hello race can never drop a frame.
  const owner = new Map<string, (frame: Frame) => void>();
  return {
    transport() {
      let deliver: (frame: Frame) => void = () => {};
      return {
        send(frame) {
          owner.set(frame.from, deliver); // this member is `frame.from`
          const direct = frame.to !== undefined ? owner.get(frame.to) : undefined;
          const targets = direct ? [direct] : members;
          for (const member of targets) if (member !== deliver) queueMicrotask(() => member(frame));
        },
        onFrame(handler) {
          deliver = handler;
          members.add(deliver);
        },
        close() {
          members.delete(deliver);
          for (const [key, value] of owner) if (value === deliver) owner.delete(key);
        },
      };
    },
  };
}

/**
 * Adapts anything with `postMessage` + message events — a `node:worker_threads` Worker or
 * `parentPort`, a web Worker, a `MessagePort` — into a {@link Transport}: one frame pipe
 * between exactly two realms. Duck-typed on purpose so the core stays universal.
 *
 * ```ts
 * const fake = {
 *   sent: [] as unknown[],
 *   postMessage(frame: unknown) {
 *     this.sent.push(frame);
 *   },
 *   on(_event: string, _handler: (frame: unknown) => void) {},
 * };
 * const transport = fromPort(fake);
 * transport.send({ kind: 'hello', from: 'main@workers' });
 * (fake.sent[0] as { kind: string }).kind; // 'hello'
 * ```
 */
export function fromPort(port: {
  postMessage(value: unknown): void;
  on?(event: 'message', handler: (value: unknown) => void): void;
  addEventListener?(event: 'message', handler: (event: { data: unknown }) => void): void;
  close?(): void;
  terminate?(): unknown;
}): Transport {
  return {
    send: (frame) => port.postMessage(frame),
    onFrame(handler) {
      if (port.on) port.on('message', (value) => handler(value as Frame));
      else port.addEventListener?.('message', (event) => handler(event.data as Frame));
    },
    close: () => void (port.close?.() ?? port.terminate?.()),
  };
}

/**
 * The Node namespace — Elixir's `Node`, JS-shaped. `Node.start(name, transport)` boots a node.
 * (`heartbeat`, `memoryHub`, `fromPort` remain bare exports — they aren't node-lifecycle entry
 * points in the same way.)
 *
 * ```ts
 * const hub = memoryHub();
 * const a = Node.start('a@node', hub.transport());
 * a.stop();
 * ```
 */
export const Node = { start };
