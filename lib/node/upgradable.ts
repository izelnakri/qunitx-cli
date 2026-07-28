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
import { Failure, type Any as AnyFailure } from '../result/failure.ts';
import type { NodeHandle } from './node.ts';

/**
 * A durable backing for a unit's state — Elixir would reach for mnesia or an external DB; this
 * is the seam, and you bring the backend (an in-memory {@link memoryStore} for tests, a
 * Postgres store for real durability — see examples/realtime-chat). State handed to `save`
 * must be structured-clone/JSON-safe for a real store.
 *
 * ```ts
 * const store = memoryStore();
 * await store.save('room:lobby', { members: ['ada'] });
 * await store.load('room:lobby'); // { members: ['ada'] }
 * ```
 */
export interface Store {
  /** The persisted state for `key`, or `undefined` if none — read once on (re)start. */
  load(key: string): Promise<unknown | undefined>;
  /** Durably persist `state` for `key`. Awaited BEFORE a reply is released (persist-before-ack). */
  save(key: string, state: unknown): Promise<void>;
  /** Forget `key` entirely. */
  clear(key: string): Promise<void>;
}

/**
 * An in-memory {@link Store} — for tests, doctests, and a single-process demo. Survives a
 * SUPERVISED restart of a unit within one process, but not process death (that needs a real
 * durable store). Snapshots by JSON round-trip so a later mutation can't change a saved copy.
 *
 * ```ts
 * const store = memoryStore();
 * await store.save('k', { n: 1 });
 * await store.load('k'); // { n: 1 }
 * await store.clear('k');
 * await store.load('k'); // undefined
 * ```
 */
export function memoryStore(): Store {
  const data = new Map<string, string>();
  return {
    load: (key) => Promise.resolve(data.has(key) ? JSON.parse(data.get(key)!) : undefined),
    save: (key, state) => (data.set(key, JSON.stringify(state)), Promise.resolve()),
    clear: (key) => (data.delete(key), Promise.resolve()),
  };
}

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
   *  completion before the next dequeues — gen_server's serialization, even for async work.
   *  When a `store` is configured (see {@link serve}), the returned state is persisted BEFORE
   *  the reply is released (durable-before-ack — no delta loss). A read-only handler should
   *  return `persist: false` to skip the write. */
  handlers: Record<
    string,
    (
      state: S,
      payload: unknown,
      from: string,
    ) =>
      | { state: S; reply?: unknown; persist?: boolean }
      | Promise<{ state: S; reply?: unknown; persist?: boolean }>
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
  /** Whether the unit still serves — false after {@link Served#exit}. */
  isAlive(): boolean;
  /**
   * Erlang's `exit/2` on this unit: stop serving (subjects now reply a declared
   * `Failure('UnitDown')`) and propagate the exit signal to every linked unit — which dies
   * with the same reason unless it traps.
   */
  exit(reason?: AnyFailure): void;
  /** Links this unit to another served unit, bidirectionally — Erlang's `link/1`: exits propagate both ways. */
  link(other: object): void;
  /**
   * Erlang's `trap_exit`: instead of dying with a linked unit, receive `(from, reason)` —
   * THROUGH the mailbox, so trap handling serializes with ordinary messages. Pass `null` to
   * un-trap.
   */
  trapExit(fn: ((from: string, reason: AnyFailure) => void) | null): void;
}

// Link wiring lives OUTSIDE the public shape: units exchange exit signals through this
// registry, keyed by handle identity — a pid table in miniature.
type ExitPort = { name: string; deliverExit: (from: string, reason: AnyFailure) => void };
const exitPorts = new WeakMap<object, ExitPort>();

/**
 * Serves a behavior on `node` under `name`: every handler key becomes the subject
 * `<name>.<key>`, plus the release-handler pair — `<name>.sys.version` answers the running
 * version, and `<name>.sys.upgrade` takes `{ url }`, dynamic-imports it (default export =
 * the next {@link Behavior}), migrates state through its `codeChange`, and swaps. That call
 * is the relup: `main.call('svc@cluster', 'greeter.sys.upgrade', { url })` upgrades a
 * REMOTE node's running code — Node.js, Deno, or a browser tab alike, since `import()` and
 * run-to-completion are web standards.
 *
 * With `{ via: { registry, key } }` the unit registers itself under that key (Elixir's
 * `{:via, Registry, {Reg, key}}`): callers reach it as `via:<registry>/<key>`, and if a
 * smaller-named node wins the same key the unit self-terminates (UnitDown) — optimistic-AP
 * conflict resolution, so callers re-resolve to the survivor. `{ store }` makes its state
 * durable (persist-before-ack + restore).
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
export function serve<S>(
  node: NodeHandle,
  name: string,
  behavior: Behavior<S>,
  options: {
    maxMailbox?: number;
    store?: Store;
    storeKey?: string;
    via?: { registry: string; key: string };
  } = {},
): Served<S> {
  let current = behavior;
  let state: S = behavior.init ? behavior.init() : (undefined as S);
  const storeKey = options.storeKey ?? name;

  // RESTORE — if a store is configured, the unit rehydrates its last durable state before
  // processing anything. The pump awaits this gate, so messages that arrive during restore
  // queue rather than run against a fresh (empty) state.
  const ready: Promise<void> = options.store
    ? options.store.load(storeKey).then((loaded) => {
        if (loaded !== undefined) state = loaded as S;
      })
    : Promise.resolve();

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
    if (options.store) await ready; // never process a message against un-restored state
    // (skipped without a store so the pump shifts synchronously — maxMailbox depth stays exact)
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
    node.handle(`${name}.${key}`, (payload, from) => {
      // Load shedding — BEAM mailboxes are unbounded (a real footgun under overload); this is
      // the disciplined floor. A full mailbox rejects new work as a declared Overloaded, which
      // crosses the wire as a failure the caller can back off on, instead of growing without
      // bound. The reply is a VALUE (a Failure); call() on the far side rejects with it.
      if (options.maxMailbox !== undefined && queue.length >= options.maxMailbox) {
        return new Failure('Overloaded', `${name} mailbox full (${queue.length})`, {
          unit: name,
          depth: queue.length,
        });
      }
      return enqueue(async () => {
        if (!unitAlive)
          return downReason ?? new Failure('UnitDown', `${name} is down`, { name, from: name });
        const outcome = await current.handlers[key](state, payload, from);
        state = outcome.state;
        // PERSIST-BEFORE-ACK — the delta-loss fix: the durable write completes (inside the
        // serial pump, so ordering holds) BEFORE the reply is released. A caller's ack means
        // the state change is durable; there is no periodic-snapshot window to lose. Reads
        // opt out with `persist: false`.
        if (options.store && outcome.persist !== false) await options.store.save(storeKey, state);
        return outcome.reply;
      });
    });

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

  let unitAlive = true;
  let downReason: AnyFailure | null = null;
  const links = new Set<ExitPort>();
  let trap: ((from: string, reason: AnyFailure) => void) | null = null;

  const deliverExit = (from: string, reason: AnyFailure): void => {
    if (!unitAlive) return;
    if (trap) {
      const handler = trap;
      void enqueue(() => handler(from, reason)); // trap handling SERIALIZES with messages
    } else {
      down(
        new Failure(
          'UnitDown',
          `${name} exited: linked to ${from}`,
          { name, from },
          { cause: reason },
        ),
      );
    }
  };
  const down = (reason: AnyFailure): void => {
    if (!unitAlive) return;
    unitAlive = false;
    downReason = reason;
    if (options.via) node.unregister(options.via.registry, options.via.key); // release the name
    for (const peer of links) peer.deliverExit(name, reason);
    links.clear();
  };

  const handle: Served<S> = {
    version: () => current.version,
    upgrade: (next) => enqueue(() => apply(next)),
    state: () => state,
    mailbox: () => queue.length + (pumping ? 1 : 0),
    isAlive: () => unitAlive,
    exit: (reason) =>
      down(reason ?? new Failure('UnitDown', `${name} exited`, { name, from: name })),
    link(other) {
      const port = exitPorts.get(other);
      if (!port) throw new TypeError('link target is not a served unit');
      links.add(port);
      const mine = exitPorts.get(handle)!;
      // reach into the other side's link set via its port: exits are symmetric, so the other
      // unit must also know us — modeled as: its deliverExit is OUR outbound, ours is its.
      otherLinks.get(port)?.add(mine);
    },
    trapExit(fn) {
      trap = fn;
    },
  };
  exitPorts.set(handle, { name, deliverExit });
  otherLinks.set(exitPorts.get(handle)!, links);
  // {:via, Registry, {Reg, key}} — register the entity key, and self-terminate if a
  // smaller-named node wins the same key (optimistic-AP conflict resolution). The loser's
  // handlers stop answering (UnitDown); callers re-resolve via whereis to the survivor.
  if (options.via) {
    node.register(options.via.registry, options.via.key, () =>
      down(
        new Failure('Conflict', `${name} lost ${options.via!.key} to another node`, {
          name,
          key: options.via!.key,
        }),
      ),
    );
  }
  // Surface this unit to sys.node.info / the observer — version, mailbox depth, liveness.
  node.inspect(name, () => ({
    version: current.version,
    mailboxDepth: queue.length + (pumping ? 1 : 0),
    alive: unitAlive,
  }));
  return handle;
}

// Maps a unit's port to its link set so link() can wire BOTH directions.
const otherLinks = new WeakMap<ExitPort, Set<ExitPort>>();
