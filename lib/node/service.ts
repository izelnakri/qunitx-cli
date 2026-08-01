// Typed RPC sugar over call/handle — closure-like call sites, name+data underneath. JS can't ship a
// closure across the wire, so the honest analog of BEAM's remote spawn is: register the CODE by a
// stable string name ahead of time (it must already exist on both sides, exactly as an Erlang release
// requires), share only the CONTRACT as a compile-time `type` (zero bytes travel), and let a typed
// Proxy turn `ledger.debit(arg)` into `node.call(to, 'ledger.debit', arg)`. You lose implicit lexical
// capture (state crosses as explicit, structured-clone-safe data); you gain no-code-on-the-wire — no
// version-skew `badfun`, no code-injection surface. Universal: leans only on a NodeHandle.
import type { NodeHandle } from './node.ts';
import type { Task } from '../task/task.ts';
import type { Any as AnyFailure } from '../result/failure.ts';

/**
 * A service contract: method name → `(arg) => result`. A PURE TYPE — it compiles to no runtime value,
 * so "sharing" it between nodes is an `import type` (zero wire/runtime cost). The string namespace is
 * the on-the-wire code identity (BEAM's module reference); the generic is compile-time only.
 */
export type Schema = Record<string, (arg: never) => unknown>;

/** Server side: same keys as the schema, each a handler. `ctx.from` mirrors node.handle's caller id. */
export type Impl<S extends Schema> = {
  [K in keyof S]: (
    arg: Parameters<S[K]>[0],
    ctx: { from: string },
  ) => ReturnType<S[K]> | Promise<ReturnType<S[K]>>;
};

/**
 * Client side: same keys, but each returns a {@link Task} carrying the declared result OR a
 * distributed failure — the closure-like call site, name+data underneath.
 */
export type Client<S extends Schema> = {
  [K in keyof S]: (
    arg: Parameters<S[K]>[0],
    timeoutMs?: number,
  ) => Task<Awaited<ReturnType<S[K]>>, AnyFailure>;
};

/** Fire-and-forget client: same keys, each returns `void` (maps to node.cast — no reply, no deadline). */
export type Caster<S extends Schema> = {
  [K in keyof S]: (arg: Parameters<S[K]>[0]) => void;
};

/**
 * Define a service once, by a stable string `namespace`. Both nodes call `defineService<Api>(name)` —
 * the `<Api>` type is checked at compile time on each side; only `name` + payloads ever travel. The
 * server {@link ServiceApi.serve}s an implementation; a caller gets a typed {@link ServiceApi.client}
 * (request/reply) or {@link ServiceApi.caster} (fire-and-forget) whose methods route by subject.
 *
 * ```ts
 * import { Node, memoryHub } from './node.ts';
 *
 * type Echo = { shout: (msg: string) => string };
 * const Echo = defineService<Echo>('echo');
 *
 * const hub = memoryHub();
 * const server = Node.start('srv@svc', hub.transport());
 * const client = Node.start('cli@svc', hub.transport());
 * Echo.serve(server, { shout: (msg) => msg.toUpperCase() });
 *
 * await Echo.client(client, 'srv@svc').shout('hi'); // 'HI' — a call across nodes, typed end to end
 * server.stop();
 * client.stop();
 * ```
 */
export function defineService<S extends Schema>(namespace: string): ServiceApi<S> {
  const subject = (method: string): string => `${namespace}.${method}`;
  return {
    serve(node, impl) {
      for (const [method, fn] of Object.entries(impl)) {
        node.handle(subject(method), (payload, from) =>
          (fn as (a: unknown, c: { from: string }) => unknown)(payload, { from }),
        );
      }
    },
    client(node, to) {
      return new Proxy({} as Client<S>, {
        get(_target, method) {
          // Guard Symbol probes (Symbol.toPrimitive, …) and `.then` thenable-detection — never let the
          // client OBJECT masquerade as awaitable; only its METHODS return the (thenable) Tasks.
          if (typeof method !== 'string' || method === 'then') return undefined;
          return (arg: unknown, timeoutMs?: number) =>
            node.call(to, subject(method), arg, timeoutMs);
        },
      });
    },
    caster(node, to) {
      return new Proxy({} as Caster<S>, {
        get(_target, method) {
          if (typeof method !== 'string' || method === 'then') return undefined;
          return (arg: unknown) => node.cast(to, subject(method), arg);
        },
      });
    },
  };
}

/**
 * The handle {@link defineService} returns — the server-side `serve` plus the two typed client
 * factories. `to` on a client/caster is a node name, `'group:<g>'` (round-robin the members), or
 * `'via:<registry>/<key>'` (route to the one owner of a key) — the same addressing {@link NodeHandle.call}
 * accepts, so group fan-out and via-routing come for free.
 */
export interface ServiceApi<S extends Schema> {
  /** Register the implementation on `node` — the CODE lives here, addressed as `${namespace}.${method}`. */
  serve(node: NodeHandle, impl: Impl<S>): void;
  /** A typed request/reply proxy over {@link NodeHandle.call}: each property access is a subject call. */
  client(node: NodeHandle, to: string): Client<S>;
  /** A typed fire-and-forget proxy over {@link NodeHandle.cast}. */
  caster(node: NodeHandle, to: string): Caster<S>;
}
