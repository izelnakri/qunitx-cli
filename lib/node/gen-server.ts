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
import { yieldWith, higher, type Priority } from './scheduler.ts';
import type { NodeHandle, Trace } from './node.ts';
import type { Service } from './supervisor.ts';
import type { Store } from './store.ts';

// The pump's reduction budget — BEAM preempts a process after ~2000 reductions; here a "reduction"
// is one processed message. `SLICE_MS` is a wall-clock ceiling for the same slice, so a handful of
// slow (but awaiting) handlers can't hold the loop for long either. When either trips, the pump
// yields (see scheduler.ts) so other actors, timers, and I/O run before it resumes draining.
const REDUCTIONS = 2000;
const SLICE_MS = 5;

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
  /** The distributed trace context this message carries, if the caller set one — for logging and
   *  propagating a span downstream. Undefined for a local self-send. */
  readonly trace?: Trace;
  /** Epoch-ms deadline after which the CALLER has given up (its call timeout), or undefined if none.
   *  A long handler can bail — `self.deadline && Date.now() > self.deadline` — instead of computing a
   *  reply nobody awaits. The transport already sheds a call that ARRIVES past its deadline; this
   *  catches one that crosses the line mid-work. */
  readonly deadline?: number;
  /** The scheduling priority this message carried, if the caller set one — read it to PROPAGATE
   *  priority to a nested `call`/`cast` (`node.call(to, subj, arg, { priority: self.priority })`). */
  readonly priority?: Priority;
  /** `GenServer.cast(self(), …)` — enqueue a message to itself; it runs AFTER the current one.
   *  `opts.priority` elevates the pump for that self-message. */
  cast(subject: K, payload?: unknown, opts?: { priority?: Priority }): void;
  /** `Process.send_after(self(), msg, ms)` — schedule a self-`cast` after `ms`, through the mailbox. */
  sendAfter(subject: K, payload: unknown, ms: number): TimerRef;
  /** `Process.exit(self(), reason)` — terminate this unit (propagates to links; a supervisor restarts). */
  exit(reason?: AnyFailure): void;
  /**
   * `Process.flag(:priority, level)` — set THIS unit's base scheduling priority at runtime (Erlang's
   * per-process priority flag), returning the PREVIOUS value. Takes effect on the pump's next slice.
   * Distinct from {@link Self.priority}, which is the current MESSAGE's carried priority: this changes
   * the unit's own baseline (raise it while doing latency-critical work, lower it for a background sweep).
   */
  setPriority(level: Priority): Priority;
  /**
   * Selective receive — `gen_statem`'s `postpone` / Akka's stash. Defer the message being handled:
   * it is neither applied nor answered now, but held and replayed (from the top of its handler) on
   * the next {@link Self.unstashAll}. Call it from a guard at the START of a handler (before side
   * effects — the handler re-runs on replay) when the unit isn't ready for this message yet. The
   * caller keeps waiting; pair it with `unstashAll` once the unit becomes ready (e.g. after init).
   */
  postpone(): void;
  /** Replay every stashed (postponed) message back through the mailbox, in the order they arrived. */
  unstashAll(): void;
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
  call(subject: K, payload?: unknown, opts?: { priority?: Priority }): Task<unknown, AnyFailure>;
  /** Fire-and-forget the local client — `gen_server:cast`. Runs the handler through the mailbox
   *  (state still mutates + persists), drops the reply. `opts.priority` elevates the pump for it. */
  cast(subject: K, payload?: unknown, opts?: { priority?: Priority }): void;
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
  /** Links this unit bidirectionally — Erlang's `link/1`: exits propagate both ways. Pass another local
   *  handle for an in-process link, or a remote ref `{ node, name }` for a DISTRIBUTED link (a unit
   *  on another node — its exit, or that node going down, signals this unit). */
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
  /**
   * Scheduling priority — Erlang's process priority. When this unit's mailbox pump exhausts its
   * reduction slice and yields, a `high`-priority unit resumes before `normal` before `low`, so a
   * background flood can't delay a latency-sensitive unit. Defaults to `normal`. Ordering only; it
   * never lets one unit block another (each pump stays an independent async body).
   */
  priority?: Priority;
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
  type Envelope = {
    run: () => unknown;
    settle: (v: unknown) => void;
    fail: (e: unknown) => void;
    priority?: Priority; // the message's carried priority, if any (elevates the pump's yield)
  };
  const queue: Envelope[] = [];
  let pumping = false;
  const enqueue = <R>(run: () => R | Promise<R>): Promise<R> =>
    new Promise<R>((settle, fail) => {
      queue.push({ run, settle: settle as (v: unknown) => void, fail });
      void pump();
    });
  // A self-settling enqueue: `run` owns its caller promise (resolve/reject captured in its closure),
  // so a POSTPONED message can be re-stashed and replayed with no second allocation — the common
  // (non-postpone) path costs exactly one promise per message, same as before. The envelope's own
  // settle/fail are no-ops. The plain `enqueue` above still serves the settle-by-return callers
  // (sys.upgrade, swap, trapExit).
  const noop = (): void => {};
  const enqueueRun = (run: () => Promise<void>, msgPriority?: Priority): void => {
    queue.push({ run, settle: noop, fail: noop, priority: msgPriority });
    void pump();
  };
  let priority: Priority = options.priority ?? 'normal'; // the unit's base priority; Process.flag can change it
  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    if (options.store) await ready; // never process a message against un-restored state
    // (skipped without a store so the pump shifts synchronously — maxMailbox depth stays exact)
    let budget = REDUCTIONS;
    let sliceStart = performance.now();
    let slicePriority = priority; // elevate to the highest-priority message seen this slice
    while (queue.length > 0) {
      const envelope = queue.shift()!;
      if (envelope.priority) slicePriority = higher(slicePriority, envelope.priority);
      try {
        envelope.settle(await envelope.run());
      } catch (thrown) {
        envelope.fail(thrown); // the caller gets RemoteCrash; the unit keeps serving
      }
      // Spend a reduction; when the slice is exhausted, yield the loop (in priority order) so timers,
      // I/O, and every OTHER actor's pump run before this one resumes. A message that carried a higher
      // priority elevates this yield, so a high-priority request resumes ahead of low-priority units.
      // Under the budget (the common case — a mailbox under REDUCTIONS deep) nothing yields.
      if (--budget <= 0 || performance.now() - sliceStart >= SLICE_MS) {
        await yieldWith(slicePriority);
        budget = REDUCTIONS;
        sliceStart = performance.now();
        slicePriority = priority;
      }
    }
    pumping = false;
  };

  // Selective-receive buffer: messages a handler POSTPONED, held as their re-runnable closures.
  // `unstashAll` replays them back through the mailbox in arrival order (they run from the top again).
  const stash: Array<{ run: () => Promise<void>; priority?: Priority }> = [];
  const unstashAll = (): void => {
    for (const held of stash.splice(0)) enqueueRun(held.run, held.priority);
  };

  // The one invocation path, shared by the remote handler (node.handle, below) and the typed LOCAL
  // client (handle.call/cast). Returns the caller's reply promise (a value, or a declared Failure —
  // Overloaded / UnitDown / whatever the handler returns). `run` self-settles that promise: a normal
  // message resolves it; a postponed one is re-stashed and the promise waits; a bug rejects it.
  const invoke = (
    key: string,
    payload: unknown,
    from: string,
    meta?: { trace?: Trace; deadline?: number; priority?: Priority },
  ): unknown => {
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
    // ONE native promise per message (same allocation as the old enqueue). `run` closes over its
    // resolve/reject, so a postponed message re-stashes the SAME closure and replays with no new alloc.
    return new Promise<unknown>((resolve, reject) => {
      const run = async (): Promise<void> => {
        if (!unitAlive) {
          resolve(downReason ?? new Failure('UnitDown', `${name} is down`, { name, from: name }));
          return;
        }
        let postponed = false;
        // The unit's view of itself for THIS message — self() + Process-style ops, who sent it, the
        // call's trace/deadline, and the stash controls (postpone THIS message, replay the stash).
        const self: Self = {
          name,
          from,
          trace: meta?.trace,
          deadline: meta?.deadline,
          priority: meta?.priority,
          cast: (subject, payload, opts) => castSelf(subject, payload, opts?.priority),
          sendAfter,
          exit: (reason) => handle.exit(reason),
          setPriority: (level) => {
            const previous = priority;
            priority = level; // the pump reads `priority` at each slice reset — takes effect next slice
            return previous;
          },
          postpone: () => void (postponed = true),
          unstashAll,
        };
        try {
          const outcome = await current.handlers[key](state, payload, self);
          // Selective receive: a postponed message is neither applied nor answered now — hold its run
          // and replay it (from the top) on the next unstashAll. The caller's promise keeps waiting.
          if (postponed) {
            stash.push({ run, priority: meta?.priority });
            return;
          }
          state = outcome.state;
          // PERSIST-BEFORE-ACK — the durable write completes (inside the serial pump, so ordering
          // holds) BEFORE the reply is released. Reads opt out with `persist: false`.
          if (options.store && outcome.persist !== false) await options.store.save(storeKey, state);
          resolve(outcome.reply);
        } catch (thrown) {
          // "Let it crash": a BUG (non-Failure throw) terminates the unit when crashOnError is set —
          // down() propagates the exit (links → onExit → supervisor restart). A declared Failure is an
          // expected reply, never a crash; a bug WITHOUT the flag becomes RemoteCrash, unit alive.
          if (options.crashOnError && !isFailure(thrown)) {
            const reason = new Failure(
              'UnitCrashed',
              `${name} crashed handling ${key}: ${String(thrown)}`,
              { name, subject: key },
              { cause: thrown },
            );
            down(reason);
            reject(reason); // the in-flight caller learns the unit died (bug carried as .cause)
            return;
          }
          reject(thrown);
        }
      };
      // the pump runs it; `run` settles this promise (or re-stashes on postpone). The message's
      // priority elevates the pump's yield so a high-priority call drains ahead of low-priority units.
      enqueueRun(run, meta?.priority);
    });
  };

  const register = (key: string) =>
    node.handle(`${name}.${key}`, (payload, from, meta) => invoke(key, payload, from, meta));

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

  // Surface this unit to sys.node.info / the observer AND the node's local-unit table — version,
  // mailbox depth, liveness. down() calls the un-register, so a dead name leaves node.units()/unit().
  const stopInspect = node.inspect(name, () => ({
    version: current.version,
    mailboxDepth: queue.length + (pumping ? 1 : 0),
    alive: unitAlive,
  }));

  const deliverExit = (from: string, reason: AnyFailure): void => {
    if (!unitAlive) return;
    if (trap) {
      const handler = trap;
      void enqueue(() => handler(from, reason)); // a trapper hears EVERY linked exit, Normal included
    } else if (reason.code !== 'Normal') {
      // A NON-trapping unit dies WITH an abnormally-exiting link, but a `Normal` exit (a linked
      // process finishing cleanly) leaves it be — Erlang's exit-signal rule.
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
  const myPort: ExitPort = { name, deliverExit };
  // Register with the node so a DISTRIBUTED link (a unit on another node) can deliver an exit here,
  // and a nodedown can synthesize one — the cross-wire half of link/1.
  const stopLinkTarget = node.registerLinkTarget?.(name, deliverExit);
  const down = (reason: AnyFailure): void => {
    if (!unitAlive) return;
    unitAlive = false;
    downReason = reason;
    if (options.via) node.unregister(options.via.registry, options.via.key); // release the name
    unstashAll(); // replay held messages so their callers settle (as UnitDown) instead of hanging
    for (const timer of timers) clearTimeout(timer); // a dead unit fires no scheduled messages
    timers.clear();
    for (const peer of links) {
      otherLinks.get(peer)?.delete(myPort); // drop the link on the PEER's side too (Erlang unlinks
      peer.deliverExit(name, reason); // both ends on any exit) — no dead port lingers in a survivor
    }
    links.clear();
    stopLinkTarget?.(); // stop receiving remote exits
    node.notifyRemoteLinks?.(name, reason); // signal units linked to me from other nodes
    stopInspect?.(); // leave the node's local-unit table — a dead name is no longer served here
    options.onDown?.(reason); // AFTER links propagate — observers see a fully-settled death
  };

  // Self-ops (Elixir's Process.*, bound to this unit) — the constant part of the `self` a handler
  // gets; `from` varies per message and is spread in by invoke(). Self-sends reuse invoke(), so they
  // ride the same mailbox: enqueued behind the current message, never reentrant.
  const castSelf = (subject: string, payload?: unknown, msgPriority?: Priority): void =>
    void Promise.resolve(
      invoke(subject, payload, name, msgPriority ? { priority: msgPriority } : undefined),
    ).catch(() => {});
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
    call: (subject, payload, opts) =>
      Task<unknown, AnyFailure>(async () => {
        let reply: unknown;
        try {
          reply = await invoke(
            subject,
            payload,
            name,
            opts?.priority ? { priority: opts.priority } : undefined,
          );
        } catch (thrown) {
          throw isFailure(thrown)
            ? thrown
            : new Failure('RemoteCrash', String(thrown), { subject });
        }
        if (isFailure(reply)) throw reply;
        return reply;
      }).perform(),
    cast: (subject, payload, opts) =>
      void Promise.resolve(
        invoke(subject, payload, name, opts?.priority ? { priority: opts.priority } : undefined),
      ).catch(() => {}),
    version: () => current.version,
    upgrade: (next) => Task(() => enqueue(() => apply(next))).perform(),
    state: () => state,
    mailbox: () => queue.length + (pumping ? 1 : 0),
    isAlive: () => unitAlive,
    exit: (reason) =>
      down(reason ?? new Failure('UnitDown', `${name} exited`, { name, from: name })),
    link(other) {
      // A remote ref `{ node, name }` links across the wire (Erlang's link to a remote pid); a local
      // handle links in-process via the shared exitPorts.
      const remote = other as { node?: unknown; name?: unknown };
      if (
        typeof remote.node === 'string' &&
        typeof remote.name === 'string' &&
        !exitPorts.has(other)
      ) {
        node.linkUnit(name, remote.node, remote.name);
        return;
      }
      const port = exitPorts.get(other);
      if (!port) throw new TypeError('link target is not a served unit');
      links.add(port);
      // reach into the other side's link set via its port: exits are symmetric, so the other
      // unit must also know us — modeled as: its deliverExit is OUR outbound, ours is its.
      otherLinks.get(port)?.add(myPort);
    },
    trapExit(fn) {
      trap = fn;
    },
  };
  exitPorts.set(handle, myPort);
  otherLinks.set(myPort, links);
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
  return handle;
}

// Maps a unit's port to its link set so link() can wire BOTH directions.
const otherLinks = new WeakMap<ExitPort, Set<ExitPort>>();

/**
 * A bare process — Erlang's `spawn(fun)`: a running body with an identity, no mailbox (no handlers to
 * `call`/`cast`). It lives while its function runs and can be linked/exited like any unit. This is the
 * subset of the unit handle a {@link spawnProcess} exposes.
 */
export interface Pid {
  /** This process's name — its identity in the node's local table (auto-assigned by `Process.spawn`). */
  readonly name: string;
  /** Whether the body is still running — Erlang's `Process.alive?/1`. */
  isAlive(): boolean;
  /** Terminate it — Erlang's `Process.exit/2`. A reason propagates to links (an abnormal exit). */
  exit(reason?: AnyFailure): void;
  /** Link bidirectionally to another unit/process — Erlang's `link/1`. */
  link(other: object): void;
}

/**
 * Run `fun(self)` as a bare process on `node` — Erlang's `spawn`. It is alive while `fun` runs and
 * leaves the node's local table when it settles. Erlang's exit-signal rule holds: returning normally
 * is a `:normal` exit that does NOT disturb linked units, while a throw (or an explicit
 * {@link Pid#exit} with a reason) is an abnormal exit that propagates. `Process.spawn` picks the
 * name and is the public door; this is the primitive it delegates the function/MFA forms to.
 *
 * ```ts
 * import { Node, memoryHub } from './node.ts';
 * import { spawnProcess } from './gen-server.ts';
 *
 * const node = Node.start('a@proc', memoryHub().transport());
 * const p = spawnProcess(node, 'worker:1', () => {});
 * p.isAlive(); // true — the body runs on a microtask, then it exits
 * node.stop();
 * ```
 */
export function spawnProcess(
  node: NodeHandle,
  name: string,
  fun: (self: Pid) => void | Promise<void>,
  options: { link?: object } = {},
): Pid {
  let alive = true;
  const links = new Set<ExitPort>();
  const stopInspect = node.inspect(name, () => ({ kind: 'process', alive }));
  // A bare process does not trap exits — an ABNORMAL linked death takes it down; a linked `Normal`
  // exit (a partner finishing cleanly) does not.
  const deliverExit = (from: string, reason: AnyFailure): void => {
    if (alive && reason.code !== 'Normal')
      down(
        new Failure(
          'ProcessDown',
          `${name} exited: linked to ${from}`,
          { name, from },
          { cause: reason },
        ),
      );
  };
  const myPort: ExitPort = { name, deliverExit };
  const down = (reason: AnyFailure | null): void => {
    if (!alive) return;
    alive = false;
    // A normal exit (fun returned) still SIGNALS links — a `Normal` reason — so a TRAPPING linker is
    // told the process finished (Erlang's `{'EXIT', _, normal}`, for completion tracking); a
    // non-trapping linker ignores it. An abnormal reason propagates as itself. Either way both ends
    // unlink so no dead port lingers.
    const signal = reason ?? new Failure('Normal', `${name} exited normally`, { name, from: name });
    for (const peer of links) {
      otherLinks.get(peer)?.delete(myPort);
      peer.deliverExit(name, signal);
    }
    links.clear();
    stopInspect();
  };
  const pid: Pid = {
    name,
    isAlive: () => alive,
    exit: (reason) =>
      down(reason ?? new Failure('ProcessDown', `${name} exited`, { name, from: name })),
    link(other) {
      const port = exitPorts.get(other);
      if (!port) throw new TypeError('link target is not a served unit');
      links.add(port);
      otherLinks.get(port)?.add(myPort);
    },
  };
  exitPorts.set(pid, myPort);
  otherLinks.set(myPort, links);
  if (options.link) pid.link(options.link);
  // Drive the body on a microtask so the caller gets the pid first; normal completion → :normal exit,
  // a throw → an abnormal exit carrying the cause.
  Promise.resolve()
    .then(() => fun(pid))
    .then(
      () => down(null),
      (thrown) =>
        down(
          isFailure(thrown)
            ? thrown
            : new Failure('ProcessCrashed', String(thrown), { name }, { cause: thrown }),
        ),
    );
  return pid;
}

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
 * import { memoryStore } from './store.ts';
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
