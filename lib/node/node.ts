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
  kind: 'hello' | 'bye' | 'cast' | 'call' | 'reply' | 'ping' | 'pong';
  from: string;
  to?: string;
  subject?: string;
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
  /** Round-trip liveness — Elixir's `Node.ping/1`: `'pong'` or, after `timeoutMs`, `'pang'`. */
  ping(name: string, timeoutMs?: number): Task<'pong' | 'pang', never>;
  /** Fires `fn(name)` when a peer says bye or its transport drops — Elixir's `Node.monitor/2`. Returns the un-monitor. */
  monitor(fn: (name: string) => void): () => void;
  /** Registers the handler for a subject; the reply (value or Failure) travels back to callers. */
  handle(subject: string, handler: (payload: unknown, from: string) => unknown): void;
  /** Request/response with a deadline. Declared failures cross intact; transport problems are declared `NodeFailure`s. */
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
  let ref = 0;
  let alive = true;

  const encode = (value: unknown): Pick<Frame, 'payload' | '$failure'> =>
    isFailure(value) ? { $failure: toJSON(value) } : { payload: value };
  const decode = (frame: Frame): unknown =>
    frame.$failure ? fromJSON(frame.$failure) : frame.payload;

  transport.onFrame((frame) => {
    if (!alive || frame.from === name || (frame.to !== undefined && frame.to !== name)) return;
    if (frame.kind === 'hello') {
      if (!peers.has(frame.from)) {
        peers.add(frame.from);
        transport.send({ kind: 'hello', from: name, to: frame.from }); // answer so both sides list()
      }
    } else if (frame.kind === 'bye') {
      if (peers.delete(frame.from)) for (const fn of monitors) fn(frame.from);
    } else if (frame.kind === 'ping') {
      transport.send({ kind: 'pong', from: name, to: frame.from, ref: frame.ref });
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
      void outcome.then((value) =>
        transport.send({
          kind: 'reply',
          from: name,
          to: frame.from,
          ref: frame.ref,
          ...encode(value),
        }),
      );
    }
  });
  transport.send({ kind: 'hello', from: name });

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
      transport.send({ kind: 'call', from: name, to, subject, ref: task.ref, ...encode(payload) });
      return task.perform() as Task<T, AnyFailure>;
    },
    cast: (to, subject, payload) =>
      transport.send({ kind: 'cast', from: name, to, subject, ...encode(payload) }),
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
