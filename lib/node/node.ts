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

/** One frame on the wire. Payloads must be structured-clone-safe; Failures ride `$failure`. */
export type Frame = {
  kind: 'hello' | 'bye' | 'join' | 'leave' | 'cast' | 'call' | 'reply' | 'ping' | 'pong';
  from: string;
  to?: string;
  subject?: string;
  /** Process-group name for join/leave frames. */
  group?: string;
  ref?: number;
  payload?: unknown;
  $failure?: SerializedFailure;
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
  /** Round-trip liveness — Elixir's `Node.ping/1`: `'pong'` or, after `timeoutMs`, `'pang'`. */
  ping(name: string, timeoutMs?: number): Task<'pong' | 'pang', never>;
  /** Fires `fn(name)` when a peer says bye or its transport drops — Elixir's `Node.monitor/2`. Returns the un-monitor. */
  monitor(fn: (name: string) => void): () => void;
  /** Registers the handler for a subject; the reply (value or Failure) travels back to callers. */
  handle(subject: string, handler: (payload: unknown, from: string) => unknown): void;
  /** Request/response with a deadline. `to` may be a node name OR `'group:<name>'` — group
   *  calls round-robin the members (a service, not a node); empty groups reject with a
   *  declared `NoGroupMembers`. Declared failures cross intact. */
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
export function start(name: string, transport: Transport): NodeHandle {
  const peers = new Set<string>();
  const handlers = new Map<string, (payload: unknown, from: string) => unknown>();
  const monitors = new Set<(name: string) => void>();
  const pending = new Map<number, (frame: Frame) => void>();
  const groups = new Map<string, Set<string>>(); // group -> members (peers and self)
  const myGroups = new Set<string>();
  const roundRobin = new Map<string, number>();
  const inspectors = new Map<string, () => Record<string, unknown>>();
  let ref = 0;
  let alive = true;

  const memberJoined = (group: string, member: string): void => {
    if (!groups.has(group)) groups.set(group, new Set());
    groups.get(group)!.add(member);
  };
  const memberLeft = (group: string, member: string): void => {
    groups.get(group)?.delete(member);
    if (groups.get(group)?.size === 0) groups.delete(group);
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
        peers.add(frame.from);
        transport.send({ kind: 'hello', from: name, to: frame.from }); // answer so both sides list()
        // Gossip my group memberships to the newcomer — how a late joiner learns the topology.
        for (const group of myGroups)
          transport.send({ kind: 'join', from: name, to: frame.from, group });
      }
    } else if (frame.kind === 'join') {
      memberJoined(frame.group!, frame.from);
    } else if (frame.kind === 'leave') {
      memberLeft(frame.group!, frame.from);
    } else if (frame.kind === 'bye') {
      for (const group of [...groups.keys()]) memberLeft(group, frame.from); // prune everywhere
      if (peers.delete(frame.from)) for (const fn of monitors) fn(frame.from);
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
    groups: Object.fromEntries([...groups].map(([g, m]) => [g, [...m]])),
    units: [...inspectors].map(([unit, report]) => ({ name: unit, ...report() })),
  }));

  // Group-aware addressing: 'group:<name>' round-robins the members — call a SERVICE, not a
  // node. A frame addressed to SELF loops back through receive (transports skip own sends).
  const dispatch = (frame: Frame): void => {
    if (frame.to === name) queueMicrotask(() => receive(frame, true));
    else transport.send(frame);
  };
  const resolveTarget = (to: string): string | null => {
    if (!to.startsWith('group:')) return to;
    const group = to.slice('group:'.length);
    const members = [...(groups.get(group) ?? [])];
    if (members.length === 0) return null;
    const at = roundRobin.get(group) ?? 0;
    roundRobin.set(group, at + 1);
    return members[at % members.length];
  };
  // Erlang reconnects re-run the handshake; so do we: a transport that redials (wsTransport
  // with reconnect) re-announces this node, and peers answer hello, rebuilding list().
  transport.onReopen?.(() => {
    transport.send({ kind: 'hello', from: name });
    for (const group of myGroups) transport.send({ kind: 'join', from: name, group }); // re-announce
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

  return {
    self: () => name,
    alive: () => alive,
    list: () => [...peers],
    join(group) {
      myGroups.add(group);
      memberJoined(group, name);
      transport.send({ kind: 'join', from: name, group });
    },
    leave(group) {
      myGroups.delete(group);
      memberLeft(group, name);
      transport.send({ kind: 'leave', from: name, group });
    },
    groupMembers: (group) => [...(groups.get(group) ?? [])],
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
      if (target === null) {
        return new Task<T, AnyFailure>(() => {
          throw new Failure('NoGroupMembers', `no members in ${to}`, { group: to });
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
        to: target,
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
      // A group cast reaches EVERY member (pg-style broadcast); a node cast reaches one.
      const targets = to.startsWith('group:')
        ? [...(groups.get(to.slice('group:'.length)) ?? [])]
        : [to];
      for (const target of targets)
        dispatch({ kind: 'cast', from: name, to: target, subject, ...encode(payload) });
    },
    stop() {
      if (!alive) return;
      alive = false;
      transport.send({ kind: 'bye', from: name });
      transport.close?.();
    },
  };
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
  return {
    transport() {
      let deliver: (frame: Frame) => void = () => {};
      return {
        send(frame) {
          for (const member of members) if (member !== deliver) queueMicrotask(() => member(frame));
        },
        onFrame(handler) {
          deliver = handler;
          members.add(deliver);
        },
        close() {
          members.delete(deliver);
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
