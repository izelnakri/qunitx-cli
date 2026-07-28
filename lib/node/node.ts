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
 * const a = start('a@memory', hub.transport());
 * const b = start('b@memory', hub.transport());
 * b.handle('math.add', (payload) => (payload as number[]).reduce((x, y) => x + y, 0));
 * await a.call('b@memory', 'math.add', [20, 22]); // 42 — across "nodes"
 * a.stop();
 * b.stop();
 * ```
 */
import {
  Failure,
  isFailure,
  toJSON,
  fromJSON,
  type SerializedFailure,
  type Any as AnyFailure,
} from '../result/failure.ts';
import { Task } from '../task/task.ts';
import { ORSet, type CrdtState, type CausalContext } from './crdt.ts';

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
 * A running node — Elixir's Node functions as methods, plus the call/cast/handle trio that
 * replaces remote spawns.
 *
 * ```ts
 * const hub = memoryHub();
 * const node = start('worker@memory', hub.transport());
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
  /** Peers seen via hello and not yet said bye — Elixir's `Node.list/0`. */
  list(): string[];
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
  monitorNodes(fn: (event: { node: string; status: 'up' | 'down' }) => void): () => void;
  /** Registers the handler for a subject; the reply (value or Failure) travels back to callers. */
  handle(subject: string, handler: (payload: unknown, from: string) => unknown): void;
  /** Request/response with a deadline. `to` may be a node name, `'group:<name>'` (round-robin
   *  the members — a service), or `'via:<registry>/<key>'` (route to the ONE owner of a key —
   *  an entity). Empty group → declared `NoGroupMembers`; unowned key → `NotRegistered`.
   *  Declared failures cross intact. */
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
   * observer dashboard) reports. `serve()` calls this for you; call it yourself to surface
   * any custom unit. Returns the un-register.
   */
  inspect(name: string, report: () => Record<string, unknown>): () => void;
}

/**
 * A liveness watcher shaped exactly like a Supervisor child — Erlang's net ticks. Pings
 * `peer` every `everyMs`; after `missAfter` consecutive pangs it reports the peer down and
 * exits (pair with `restart: 'permanent'` to keep watching forever, `'transient'` to stop
 * once down is reported).
 *
 * ```ts
 * const hub = memoryHub();
 * const watcher = start('watcher@memory', hub.transport());
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
 * const left = start('left@memory', hub.transport());
 * const right = start('right@memory', hub.transport());
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
  } = {},
): NodeHandle {
  const peers = new Set<string>();
  const handlers = new Map<string, (payload: unknown, from: string) => unknown>();
  const monitors = new Set<(name: string) => void>();
  const nodeListeners = new Set<(event: { node: string; status: 'up' | 'down' }) => void>();
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
  const factsWithPrefix = (prefix: string): string[] =>
    crdt
      .values()
      .filter((f) => f.startsWith(prefix))
      .map((f) => f.slice(prefix.length));
  const groupMembersOf = (group: string): string[] =>
    factsWithPrefix(`g\u001f${group}\u001f`).filter(isLive);
  const allGroups = (): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const fact of crdt.values()) {
      if (!fact.startsWith('g\u001f')) continue;
      const rest = fact.slice(2);
      const sep = rest.indexOf('\u001f');
      const group = rest.slice(0, sep);
      const member = rest.slice(sep + 1);
      if (isLive(member)) (out[group] ??= []).push(member);
    }
    return out;
  };
  const ownersOf = (registry: string, key: string): string[] =>
    factsWithPrefix(`r\u001f${registry}\u001f${key}\u001f`).filter(isLive);

  // Broadcast a one-op CRDT delta (from crdt.add/remove) to every peer — immediate propagation;
  // anti-entropy (full state) backstops any that's dropped.
  const broadcastDelta = (delta: CrdtState): void =>
    transport.send({ kind: 'crdt', from: name, crdt: delta, full: false });

  // After any merge: a key I own may now have a smaller LIVE owner — fire its conflict handler
  // (drives serve({via}) self-terminate). A partition that elected two owners heals to one.
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
    if (peers.delete(peer)) {
      for (const fn of monitors) fn(peer);
      for (const fn of nodeListeners) fn({ node: peer, status: 'down' }); // Erlang nodedown
    }
  };
  const inspectors = new Map<string, () => Record<string, unknown>>();
  let ref = 0;
  let alive = true;

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
        peers.add(frame.from);
        for (const fn of nodeListeners) fn({ node: frame.from, status: 'up' }); // Erlang nodeup
        transport.send({ kind: 'hello', from: name, to: frame.from }); // answer so both sides list()
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
      handlers.get(frame.subject!)?.(decode(frame), frame.from);
    } else if (frame.kind === 'call') {
      const handler = handlers.get(frame.subject!);
      const outcome = handler
        ? Promise.resolve()
            .then(() => handler(decode(frame), frame.from))
            .catch((thrown: unknown) =>
              isFailure(thrown)
                ? thrown
                : new Failure('RemoteCrash', String(thrown), { subject: frame.subject }),
            )
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
  transport.send({ kind: 'hello', from: name });

  // The observer protocol — one subject any node (or a browser dashboard node) can call to
  // read this node's live state. Erlang's :observer, reduced to data over the same wire.
  handlers.set('sys.node.info', () => ({
    name,
    peers: [...peers],
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
    transport.send({ kind: 'hello', from: name });
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
    list: () => [...peers],
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
    monitorNodes(fn) {
      nodeListeners.add(fn);
      return () => nodeListeners.delete(fn);
    },
    handle: (subject, handler) => void handlers.set(subject, handler),
    call<T>(to: string, subject: string, payload?: unknown, timeoutMs = 5000) {
      const task = awaitRef<T>(
        timeoutMs,
        (frame) => {
          const value = decode(frame);
          if (isFailure(value)) throw value; // a remote DECLARED failure stays declared here
          return value as T;
        },
        () => {
          throw new Failure(
            'CallTimeout',
            `call ${subject} to ${to} timed out after ${timeoutMs}ms`,
            { to, subject },
          );
        },
      ) as Task<T, never> & { ref: number };
      const target = resolveTarget(to);
      if ('empty' in target) {
        return new Task<T, AnyFailure>(() => {
          throw target.empty === 'group'
            ? new Failure('NoGroupMembers', `no members in ${to}`, { group: to })
            : new Failure('NotRegistered', `no owner for ${to}`, { via: to });
        });
      }
      task.perform(); // sets up the reply resolver NOW, before the frame goes out
      // Claim the eager reply's rejection. call() is request/response — the returned Task is
      // always consumed (await or .result()) — but a FAST rejection (e.g. an Overloaded shed)
      // can settle before a lazy `.result()` attaches its handler, which would surface as a
      // spurious unhandled rejection. This passive handler marks it handled; the caller's own
      // await/.result() still sees the settlement (a Task memoises to all consumers).
      task.then(undefined, () => {});
      dispatch({
        kind: 'call',
        from: name,
        to: target.node,
        subject,
        ref: task.ref,
        ...encode(payload),
      });
      return task as Task<T, AnyFailure>;
    },
    inspect(unit, report) {
      inspectors.set(unit, report);
      return () => inspectors.delete(unit);
    },
    cast(to, subject, payload) {
      // A group cast reaches EVERY member (pg-style broadcast); a via: cast reaches the key's
      // owner; a node cast reaches one node.
      let targets: string[];
      if (to.startsWith('group:')) targets = groupMembersOf(to.slice('group:'.length));
      else if (to.startsWith('via:')) {
        const resolved = resolveTarget(to);
        targets = 'node' in resolved ? [resolved.node] : [];
      } else targets = [to];
      for (const target of targets)
        dispatch({ kind: 'cast', from: name, to: target, subject, ...encode(payload) });
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
      for (const peer of [...peers]) {
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
      const list = [...peers];
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
 * const a = start('a@memory', hub.transport());
 * const b = start('b@memory', hub.transport());
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
