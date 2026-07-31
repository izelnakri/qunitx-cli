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
 * import { Node, memoryHub } from './node.ts';
 *
 * const node = Node.start('svc@memory', memoryHub().transport());
 * const served = genServer(node, 'greeter', {
 *   version: '1.0.0',
 *   init: () => ({ greeted: 0 }),
 *   handlers: { hello: (state, name) => ({ state: { greeted: state.greeted + 1 }, reply: `Hello ${name}` }) },
 * });
 * served.version(); // '1.0.0'
 * node.stop();
 * ```
 */
import { Failure, isFailure, type Any as AnyFailure } from '../result/failure.ts';
import { Task } from '../task/task.ts';
import type { NodeHandle } from './node.ts';
import type { Service } from './supervisor.ts';

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
  /**
   * Atomically claim up to `limit` runnable jobs for `queue` — the multi-node coordinator of a
   * work queue, Oban's `SELECT … FOR UPDATE SKIP LOCKED` + mark-executing. Entries under `prefix`
   * are jobs `{ queue, state, scheduledAt, priority, attempt }`; a candidate has `state` in `ready`
   * and `scheduledAt <= now`. The first `limit`, ordered priority then scheduledAt, are each marked
   * `executing` with `attempt + 1`, persisted, and returned — in ONE turn (memoryStore) or ONE
   * transaction (Postgres), so concurrent drainers on separate nodes never grab the same job.
   * Omit it and {@link Job.queue} drains only its own in-memory inserts (single-writer).
   */
  claim?(
    prefix: string,
    queue: string,
    ready: readonly string[],
    now: number,
    limit: number,
  ): Promise<unknown[]>;
  /**
   * Atomically acquire or renew a lease on `key` for `candidate` for `ttlMs` — Elixir's `Oban.Peer`
   * leadership (a Postgres advisory lock, or the `:global` singleton). If `key` is unheld, expired,
   * or already `candidate`'s, it becomes `candidate`'s until `now + ttlMs`; either way the CURRENT
   * holder is returned (`=== candidate` ⇒ you lead). One turn (memoryStore) or one statement
   * (Postgres), so exactly one candidate ever holds it — the coordinator for cluster-once work (cron)
   * or, with no {@link Store.claim}, for electing a single drainer.
   *
   * TWO caveats a real backend must respect: (1) use the store's OWN clock for the expiry check
   * (Postgres `now()`), NOT the caller's `now` — across skewed node clocks a TTL lease would elect
   * two holders. (2) A TTL lease has a brief split-brain window if a holder pauses (GC/stall) past
   * its lease; the strongest backend is a session-scoped lock (a held Postgres advisory lock,
   * auto-released on disconnect — no TTL). For cron the stakes are low (a duplicate enqueue, mostly
   * deduped). `now` here is the in-process/test clock a `memoryStore` trusts.
   */
  lease?(key: string, candidate: string, now: number, ttlMs: number): Promise<string>;
  /**
   * Reset jobs stuck `executing` since before `staleBefore` (their `attemptedAt`) back to
   * `available` — the Stager/rescuer that recovers work orphaned when a node died mid-run (Oban's
   * rescuer). A job already out of attempts is `discarded` (dead-lettered) instead. Returns how many
   * were reset. Meant to run gated behind a {@link Leader} (once per cluster). `staleBefore` must be
   * older than the longest job runtime, or a still-running long job would be wrongly reclaimed.
   */
  rescue?(prefix: string, staleBefore: number): Promise<number>;
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
    claim: (prefix, queue, ready, now, limit) => {
      // One synchronous turn — the in-process equivalent of FOR UPDATE SKIP LOCKED: no other tick
      // can interleave between selecting a candidate and marking it executing, so two drainers on
      // one store never claim the same job.
      const claimed = [...data.entries()]
        .filter(([key]) => key.startsWith(`${prefix}:`))
        .map(([key, raw]) => [key, JSON.parse(raw)] as [string, Record<string, unknown>])
        .filter(
          ([, job]) =>
            job.queue === queue &&
            ready.includes(job.state as string) &&
            (job.scheduledAt as number) <= now,
        )
        .sort(
          ([, a], [, b]) =>
            (a.priority as number) - (b.priority as number) ||
            (a.scheduledAt as number) - (b.scheduledAt as number),
        )
        .slice(0, limit)
        .map(([key, job]) => {
          const marked = {
            ...job,
            state: 'executing',
            attempt: (job.attempt as number) + 1,
            attemptedAt: now, // stamp when it started running — the stager keys on this
          };
          data.set(key, JSON.stringify(marked));
          return marked;
        });
      return Promise.resolve(claimed);
    },
    rescue: (prefix, staleBefore) => {
      let reset = 0;
      for (const [key, raw] of data.entries()) {
        if (!key.startsWith(`${prefix}:`)) continue;
        const job = JSON.parse(raw) as Record<string, unknown>;
        const attemptedAt = (job.attemptedAt as number | undefined) ?? Infinity; // unstamped = never stale
        if (job.state !== 'executing' || attemptedAt > staleBefore) continue;
        job.state =
          (job.attempt as number) >= (job.maxAttempts as number) ? 'discarded' : 'available';
        data.set(key, JSON.stringify(job));
        reset += 1;
      }
      return Promise.resolve(reset);
    },
    lease: (key, candidate, now, ttlMs) => {
      const raw = data.get(key);
      const held = raw ? (JSON.parse(raw) as { owner: string; expiresAt: number }) : undefined;
      if (!held || held.expiresAt <= now || held.owner === candidate) {
        data.set(key, JSON.stringify({ owner: candidate, expiresAt: now + ttlMs }));
        return Promise.resolve(candidate);
      }
      return Promise.resolve(held.owner);
    },
  };
}

/** A cancellable scheduled message — the handle {@link Self#sendAfter} returns (Erlang's timer ref). */
export interface TimerRef {
  /** Cancel the pending message if it has not fired yet; a no-op once it has. */
  cancel(): void;
}

/**
 * The unit's view of ITSELF, handed to every handler as the third argument — Elixir's `self()` plus
 * the `Process.*` operations a gen_server callback runs on its own pid, bound to this unit. It is NOT
 * a global `Process` module: our unit already IS the process, so `Process.send_after(self(), …)` is
 * spelled `self.sendAfter(…)`. Self-sends run THROUGH the mailbox (serialized, run-to-completion —
 * never reentrant), and pending timers are cancelled when the unit goes down. `subject` is constrained
 * to the behavior's handler keys, like the typed local client.
 */
export interface Self<K extends string = string> {
  /** `self()` — this unit's own name (the subject prefix it serves under). */
  readonly name: string;
  /** Who sent the message being handled — a peer node's name over the wire, or this unit for a
   *  self-send/local call. Erlang's `from` (minus the reply ref, which the mailbox owns). */
  readonly from: string;
  /** `GenServer.cast(self(), …)` — enqueue a message to itself; it runs AFTER the current one. */
  cast(subject: K, payload?: unknown): void;
  /** `Process.send_after(self(), msg, ms)` — schedule a self-`cast` after `ms`, through the mailbox. */
  sendAfter(subject: K, payload: unknown, ms: number): TimerRef;
  /** `Process.exit(self(), reason)` — terminate this unit (propagates to links; a supervisor restarts). */
  exit(reason?: AnyFailure): void;
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
export interface Behavior<S, K extends string = string> {
  /** The release name this behavior IS — what `sys.version` answers and `codeChange` receives. */
  version: string;
  /** First-boot state. Ignored on upgrade — `codeChange` owns that path. */
  init?: () => S;
  /** Message handlers — sync or async; each returns the next state and (for calls) the reply.
   *  Handlers run through the unit's MAILBOX: strictly one at a time, each awaited to
   *  completion before the next dequeues — gen_server's serialization, even for async work.
   *  When a `store` is configured (see {@link genServer}), the returned state is persisted BEFORE
   *  the reply is released (durable-before-ack — no delta loss). A read-only handler should
   *  return `persist: false` to skip the write. The third arg is {@link Self} — `self()` + the
   *  `Process.*` self-ops (`self.from`, `self.cast`, `self.sendAfter`, `self.exit`). The key set `K`
   *  is inferred, so both the returned {@link GenServer} and `self` are typed over exactly these
   *  subjects. */
  handlers: Record<
    K,
    (
      state: S,
      payload: unknown,
      self: Self<K>,
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
 * import { Node, memoryHub } from './node.ts';
 *
 * const node = Node.start('u@memory', memoryHub().transport());
 * const served = genServer(node, 'counter', {
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
export interface GenServer<S, K extends string = string> {
  /**
   * The typed LOCAL client — `gen_server:call` for the process holding this handle. Invoke one of
   * the unit's own handlers by key (`subject` is constrained to the behavior's handler names), get
   * the reply back as a Task. Runs THROUGH the mailbox and persists like any message, but takes no
   * wire hop — no `node.call(nodeName, '<name>.<subject>', …)` round-trip. A handler that returns
   * (or throws) a declared `Failure` rejects the Task; an over-full mailbox rejects with `Overloaded`.
   */
  call(subject: K, payload?: unknown): Task<unknown, AnyFailure>;
  /** Fire-and-forget the local client — `gen_server:cast`. Runs the handler through the mailbox
   *  (state still mutates + persists), drops the reply. */
  cast(subject: K, payload?: unknown): void;
  /** The currently running version. */
  version(): string;
  /** Swap via the mailbox — lands strictly BETWEEN messages, even async ones. An eager Task
   *  settling with the new version (`.result()`/`.retry()` compose like every public async result). */
  upgrade(next: Behavior<S>): Task<string, AnyFailure>;
  /** The current state (for checkpointing before risky upgrades). */
  state(): S;
  /** Messages queued or in flight — what observer tooling reads as mailbox depth. */
  mailbox(): number;
  /** Whether the unit still serves — false after {@link GenServer#exit}. */
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

/** Options for {@link genServer}. */
export interface GenServerOptions {
  /** Shed new work as a declared `Overloaded` once this many messages are queued (backpressure). */
  maxMailbox?: number;
  /** Durable backing — state persists before a reply is released and rehydrates on (re)start. */
  store?: Store;
  /** Key under which state is persisted (defaults to `name`). */
  storeKey?: string;
  /** Register under a cluster-wide name — Elixir's `{:via, Registry, {Reg, key}}`. */
  via?: { registry: string; key: string };
  /**
   * OTP's "let it crash": a handler throwing a **bug** (a non-`Failure`) TERMINATES the unit —
   * `down()` fires the exit signal (links → `onExit` → a supervisor restarts it) and the in-flight
   * caller gets a `UnitCrashed` failure (the bug as its `.cause`). When off, that same throw is
   * answered as a `RemoteCrash` reply and the unit keeps serving. Either way a thrown or returned
   * declared `Failure` is an EXPECTED outcome and never crashes — only bugs do. Pair with a `store`
   * (and a supervisor) so the restarted unit rehydrates instead of losing state.
   *
   * DEFAULT depends on whether a restarter exists: a bare {@link genServer} defaults **off** (an
   * unsupervised unit shouldn't self-destruct permanently on one bug — it degrades by replying the
   * error), while {@link superviseGenServer} defaults it **on** (you supervised it, so let it crash).
   */
  crashOnError?: boolean;
  /**
   * Fired ONCE when the unit goes down — via `exit()`, a linked unit's death, a `via` conflict, or a
   * `crashOnError` bug. The seam {@link superviseGenServer} uses to bridge a unit's death to a
   * supervisor's `onExit`; most code reaches for {@link GenServer#link}/`trapExit` instead.
   */
  onDown?: (reason: AnyFailure) => void;
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
 * With `{ via: { registry, key } }` the unit registers itself under that key (Elixir's
 * `{:via, Registry, {Reg, key}}`): callers reach it as `via:<registry>/<key>`, and if a
 * smaller-named node wins the same key the unit self-terminates (UnitDown) — optimistic-AP
 * conflict resolution, so callers re-resolve to the survivor. `{ store }` makes its state
 * durable (persist-before-ack + restore).
 *
 * ```ts
 * import { Node, memoryHub } from './node.ts';
 *
 * const hub = memoryHub();
 * const svc = Node.start('svc@memory', hub.transport());
 * const cli = Node.start('cli@memory', hub.transport());
 * const greeter = genServer(svc, 'greeter', {
 *   version: '1.0.0',
 *   init: () => ({ greeted: 0 }),
 *   handlers: { hello: (state, name) => ({ state: { greeted: state.greeted + 1 }, reply: `Hello ${name}` }) },
 * });
 * await greeter.call('hello', 'ada'); // 'Hello ada' — LOCAL, through the mailbox, no wire hop
 * await cli.call('svc@memory', 'greeter.hello', 'ada'); // 'Hello ada' — the same handler, over the wire
 * await cli.call('svc@memory', 'greeter.sys.version'); // '1.0.0'
 * svc.stop();
 * cli.stop();
 * ```
 */
export function genServer<S, K extends string = string>(
  node: NodeHandle,
  name: string,
  behavior: Behavior<S, K>,
  options: GenServerOptions = {},
): GenServer<S, K> {
  let current: Behavior<S> = behavior; // widen internally to string keys; K is a public-surface detail
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

  // The one invocation path, shared by the remote handler (node.handle, below) and the typed LOCAL
  // client (handle.call/cast). Returns the reply — a value, or a declared Failure (Overloaded /
  // UnitDown / whatever the handler returns). A handler THROW rejects the enqueue promise.
  const invoke = (key: string, payload: unknown, from: string): unknown => {
    // Load shedding — BEAM mailboxes are unbounded (a real footgun under overload); this is the
    // disciplined floor. A full mailbox rejects new work as a declared Overloaded the caller can
    // back off on, instead of growing without bound. The reply is a VALUE (a Failure); call()
    // rejects with it.
    if (options.maxMailbox !== undefined && queue.length >= options.maxMailbox) {
      return new Failure('Overloaded', `${name} mailbox full (${queue.length})`, {
        unit: name,
        depth: queue.length,
      });
    }
    return enqueue(async () => {
      if (!unitAlive)
        return downReason ?? new Failure('UnitDown', `${name} is down`, { name, from: name });
      // The unit's view of itself for THIS message — self() + Process-style ops, plus who sent it.
      const self: Self = {
        name,
        from,
        cast: castSelf,
        sendAfter,
        exit: (reason) => handle.exit(reason),
      };
      let outcome: { state: S; reply?: unknown; persist?: boolean };
      try {
        outcome = await current.handlers[key](state, payload, self);
      } catch (thrown) {
        // "Let it crash": a BUG (non-Failure throw) terminates the unit when crashOnError is set —
        // down() propagates the exit (links → onExit → supervisor restart). A declared Failure is an
        // expected reply, never a crash; a bug WITHOUT the flag rejects as RemoteCrash, unit alive.
        if (options.crashOnError && !isFailure(thrown)) {
          const reason = new Failure(
            'UnitCrashed',
            `${name} crashed handling ${key}: ${String(thrown)}`,
            { name, subject: key },
            { cause: thrown },
          );
          down(reason);
          throw reason; // the in-flight caller learns the unit died (bug carried as .cause)
        }
        throw thrown;
      }
      state = outcome.state;
      // PERSIST-BEFORE-ACK — the delta-loss fix: the durable write completes (inside the serial
      // pump, so ordering holds) BEFORE the reply is released. A caller's ack means the state
      // change is durable; there is no periodic-snapshot window to lose. Reads opt out with
      // `persist: false`.
      if (options.store && outcome.persist !== false) await options.store.save(storeKey, state);
      return outcome.reply;
    });
  };

  const register = (key: string) =>
    node.handle(`${name}.${key}`, (payload, from) => invoke(key, payload, from));

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
  const timers = new Set<ReturnType<typeof setTimeout>>(); // pending sendAfter timers, cleared on down
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
    for (const timer of timers) clearTimeout(timer); // a dead unit fires no scheduled messages
    timers.clear();
    for (const peer of links) peer.deliverExit(name, reason);
    links.clear();
    options.onDown?.(reason); // AFTER links propagate — observers see a fully-settled death
  };

  // Self-ops (Elixir's Process.*, bound to this unit) — the constant part of the `self` a handler
  // gets; `from` varies per message and is spread in by invoke(). Self-sends reuse invoke(), so they
  // ride the same mailbox: enqueued behind the current message, never reentrant.
  const castSelf = (subject: string, payload?: unknown): void =>
    void Promise.resolve(invoke(subject, payload, name)).catch(() => {});
  const sendAfter = (subject: string, payload: unknown, ms: number): TimerRef => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (unitAlive) castSelf(subject, payload);
    }, ms);
    timers.add(timer);
    return {
      cancel: () => {
        if (timers.delete(timer)) clearTimeout(timer);
      },
    };
  };

  const handle: GenServer<S, K> = {
    // The typed local client — invoke a handler in-process, no wire hop. Whatever the remote
    // `node.call` path would surface, this does too: a declared Failure (returned OR thrown) rejects
    // the Task as itself; a bug (a non-Failure throw) rejects as RemoteCrash — so Task<_, AnyFailure>
    // never leaks a bare Error, local or remote.
    call: (subject, payload) =>
      Task<unknown, AnyFailure>(async () => {
        let reply: unknown;
        try {
          reply = await invoke(subject, payload, name);
        } catch (thrown) {
          throw isFailure(thrown)
            ? thrown
            : new Failure('RemoteCrash', String(thrown), { subject });
        }
        if (isFailure(reply)) throw reply;
        return reply;
      }).perform(),
    cast: (subject, payload) =>
      void Promise.resolve(invoke(subject, payload, name)).catch(() => {}),
    version: () => current.version,
    upgrade: (next) => Task(() => enqueue(() => apply(next))).perform(),
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

/**
 * A {@link genServer} wrapped as a supervisable {@link Service} — the bridge that lets a stateful
 * gen_server be a child of a {@link distributedSupervisor} (or a local `supervisor`). It wires the
 * two things the raw handle lacks: `stop()` (graceful teardown → `exit()`, which does NOT report as
 * a crash) and `onExit(handler)` (an ABNORMAL death — a linked unit's crash, an external `exit(reason)`,
 * a `via` conflict — so the supervisor restarts it in place). The returned value still IS the handle:
 * `.call`/`.cast`/`.state`/`.upgrade` all work, so `sup.local(key)` is a usable typed client.
 *
 * Pair it with a durable `store` and failover is state-preserving: on node loss the key re-homes to a
 * survivor, whose fresh unit rehydrates from the same store (persist-before-ack) — the OTP/Horde story,
 * minus a live process migration (a JS runtime can't hand a running closure across nodes).
 *
 * Because it IS supervised, `crashOnError` defaults **on** here (unlike a bare `genServer`): a handler
 * bug crashes the unit and the supervisor restarts it — the reason you supervised it. Pass
 * `crashOnError: false` to keep it answering bugs as replies instead.
 *
 * ```ts
 * import { Node, memoryHub } from './node.ts';
 * import { shardedRegistry } from './sharded-registry.ts';
 * import { distributedSupervisor } from './distributed-supervisor.ts';
 *
 * const store = memoryStore(); // one shared store stands in for a cluster DB
 * const node = Node.start('solo@ds', memoryHub().transport());
 * const sup = distributedSupervisor(node, shardedRegistry(node), {
 *   name: 'counters',
 *   desired: ['c1'],
 *   start: (key) =>
 *     superviseGenServer(
 *       node,
 *       key,
 *       {
 *         version: '1',
 *         init: () => 0,
 *         handlers: { bump: (n, by) => ({ state: n + (by as number), reply: n + (by as number) }) },
 *       },
 *       { store, storeKey: key },
 *     ),
 * });
 * typeof sup.ensure; // 'function'
 * await sup.stop();
 * node.stop();
 * ```
 */
export function superviseGenServer<S, K extends string = string>(
  node: NodeHandle,
  name: string,
  behavior: Behavior<S, K>,
  options: Omit<GenServerOptions, 'onDown'> = {},
): GenServer<S, K> & Service {
  let onExit: ((reason?: unknown) => void) | undefined;
  let stopping = false;
  const handle = genServer(node, name, behavior, {
    ...options,
    // Supervised → "let it crash" by DEFAULT (OTP): a handler bug should restart the unit, since a
    // restarter is the whole reason you supervised it. Bare genServer defaults the other way (no
    // restarter → don't self-destruct on one bug). Override with `crashOnError: false` to keep a
    // supervised unit answering bugs instead of crashing.
    crashOnError: options.crashOnError ?? true,
    // A graceful stop() flips `stopping` first, so its own down() must NOT report as a crash
    // (the Service contract). Any other death — linked crash, via conflict, external exit — does.
    onDown: (reason) => {
      if (!stopping) onExit?.(reason);
    },
  });
  return {
    ...handle,
    onExit: (handler) => void (onExit = handler),
    stop: () => {
      stopping = true;
      handle.exit();
    },
  };
}
