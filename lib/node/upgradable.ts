/**
 * Hot code upgrades — Erlang's release mechanics, JS-shaped. The mapping that makes it work:
 *
 * | Erlang                          | here                                                    |
 * | ------------------------------- | ------------------------------------------------------- |
 * | code server holds two versions  | module versions are URLs; `import()` loads the next     |
 * | suspend → swap → resume         | FREE: run-to-completion — swaps land between messages   |
 * | `code_change/3` migrates state  | `codeChange(fromVersion, oldState)` on the NEW behavior |
 * | relup pushes across the cluster | `call(peer, '<name>.sys.upgrade', { url })`             |
 * | downgrade (`{down, Vsn}`)       | same call with an older version's URL                   |
 *
 * A served behavior keeps answering during the swap — callers in flight complete against the
 * old handlers, the next message meets the new ones, and the state crossed over through
 * `codeChange`. That is the whole zero-downtime story, minus Erlang's ability to swap the
 * VM itself (a JS runtime restart still needs a rolling deploy — stated, not hidden).
 *
 * ```ts
 * import { start, memoryHub } from './node.ts';
 *
 * const node = start('svc@memory', memoryHub().transport());
 * const served = serve(node, 'greeter', {
 *   version: '1.0.0',
 *   init: () => ({ greeted: 0 }),
 *   handlers: { hello: (state, name) => ({ state: { greeted: state.greeted + 1 }, reply: `Hello ${name}` }) },
 * });
 * served.version(); // '1.0.0'
 * node.stop();
 * ```
 */
import type { NodeHandle } from './node.ts';

/**
 * A versioned GenServer-ish unit: pure-ish handlers over owned state, plus the migration
 * hook. `codeChange` runs on the INCOMING behavior (like Erlang: the new module knows how to
 * read old state), for upgrades and downgrades alike — `fromVersion` says which way you came.
 *
 * ```ts
 * const v2: Behavior<{ greeted: number; lang: string }> = {
 *   version: '2.0.0',
 *   handlers: { hello: (state, name) => ({ state, reply: `Hallo ${name} (${state.lang})` }) },
 *   codeChange: (_fromVersion, oldState) => ({ ...(oldState as { greeted: number }), lang: 'de' }),
 * };
 * v2.version; // '2.0.0'
 * ```
 */
export interface Behavior<S> {
  /** The release name this behavior IS — what `sys.version` answers and `codeChange` receives. */
  version: string;
  /** First-boot state. Ignored on upgrade — `codeChange` owns that path. */
  init?: () => S;
  /** Message handlers — sync or async; each returns the next state and (for calls) the reply.
   *  Handlers run through the unit's MAILBOX: strictly one at a time, each awaited to
   *  completion before the next dequeues — gen_server's serialization, even for async work. */
  handlers: Record<
    string,
    (
      state: S,
      payload: unknown,
      from: string,
    ) => { state: S; reply?: unknown } | Promise<{ state: S; reply?: unknown }>
  >;
  /** Erlang's `code_change/3`: migrate the previous version's state into this version's shape. */
  codeChange?: (fromVersion: string, oldState: unknown) => S;
}

/**
 * The running, upgradable unit — swap behaviors locally or let the cluster do it through
 * the auto-registered `<name>.sys.upgrade` / `<name>.sys.version` subjects.
 *
 * ```ts
 * import { start, memoryHub } from './node.ts';
 *
 * const node = start('u@memory', memoryHub().transport());
 * const served = serve(node, 'counter', {
 *   version: '1',
 *   init: () => 0,
 *   handlers: { bump: (state) => ({ state: state + 1, reply: state + 1 }) },
 * });
 * await served.upgrade({
 *   version: '2',
 *   handlers: { bump: (state) => ({ state: state + 10, reply: state + 10 }) },
 *   codeChange: (_from, old) => (old as number) * 100, // the state CROSSED, migrated
 * });
 * served.version(); // '2'
 * node.stop();
 * ```
 */
export interface Served<S> {
  /** The currently running version. */
  version(): string;
  /** Swap via the mailbox — lands strictly BETWEEN messages, even async ones. Resolves to the new version. */
  upgrade(next: Behavior<S>): Promise<string>;
  /** The current state (for checkpointing before risky upgrades). */
  state(): S;
  /** Messages queued or in flight — what observer tooling reads as mailbox depth. */
  mailbox(): number;
}

/**
 * Serves a behavior on `node` under `name`: every handler key becomes the subject
 * `<name>.<key>`, plus the release-handler pair — `<name>.sys.version` answers the running
 * version, and `<name>.sys.upgrade` takes `{ url }`, dynamic-imports it (default export =
 * the next {@link Behavior}), migrates state through its `codeChange`, and swaps. That call
 * is the relup: `main.call('svc@cluster', 'greeter.sys.upgrade', { url })` upgrades a
 * REMOTE node's running code — Node.js, Deno, or a browser tab alike, since `import()` and
 * run-to-completion are web standards.
 *
 * ```ts
 * import { start, memoryHub } from './node.ts';
 *
 * const hub = memoryHub();
 * const svc = start('svc@memory', hub.transport());
 * const cli = start('cli@memory', hub.transport());
 * serve(svc, 'greeter', {
 *   version: '1.0.0',
 *   init: () => ({ greeted: 0 }),
 *   handlers: { hello: (state, name) => ({ state: { greeted: state.greeted + 1 }, reply: `Hello ${name}` }) },
 * });
 * await cli.call('svc@memory', 'greeter.hello', 'ada'); // 'Hello ada'
 * await cli.call('svc@memory', 'greeter.sys.version'); // '1.0.0'
 * svc.stop();
 * cli.stop();
 * ```
 */
export function serve<S>(node: NodeHandle, name: string, behavior: Behavior<S>): Served<S> {
  let current = behavior;
  let state: S = behavior.init ? behavior.init() : (undefined as S);

  // THE MAILBOX — gen_server's real guarantee, which run-to-completion alone cannot give
  // once handlers are async: every message (and every swap) enqueues, and ONE pump drains
  // strictly serially, awaiting each to completion. Nothing interleaves, ever.
  type Envelope = { run: () => unknown; settle: (v: unknown) => void; fail: (e: unknown) => void };
  const queue: Envelope[] = [];
  let pumping = false;
  const enqueue = <R>(run: () => R | Promise<R>): Promise<R> =>
    new Promise<R>((settle, fail) => {
      queue.push({ run, settle: settle as (v: unknown) => void, fail });
      void pump();
    });
  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    while (queue.length > 0) {
      const envelope = queue.shift()!;
      try {
        envelope.settle(await envelope.run());
      } catch (thrown) {
        envelope.fail(thrown); // the caller gets RemoteCrash; the unit keeps serving
      }
    }
    pumping = false;
  };

  const register = (key: string) =>
    node.handle(`${name}.${key}`, (payload, from) =>
      enqueue(async () => {
        const outcome = await current.handlers[key](state, payload, from);
        state = outcome.state;
        return outcome.reply;
      }),
    );

  const apply = (next: Behavior<S>): string => {
    const fromVersion = current.version;
    if (next.codeChange) state = next.codeChange(fromVersion, state);
    current = next;
    for (const key of Object.keys(next.handlers)) register(key); // new keys in new versions
    return next.version;
  };

  for (const key of Object.keys(behavior.handlers)) register(key);
  node.handle(`${name}.sys.version`, () => current.version);
  node.handle(`${name}.sys.upgrade`, (payload) =>
    enqueue(async () => {
      const { url } = payload as { url: string };
      const module = (await import(url)) as { default: Behavior<S> };
      return apply(module.default);
    }),
  );

  return {
    version: () => current.version,
    upgrade: (next) => enqueue(() => apply(next)),
    state: () => state,
    mailbox: () => queue.length + (pumping ? 1 : 0),
  };
}
