import type { Result } from '../result/result.ts';
import {
  define as defineFailure,
  Failure,
  ignore as failureIgnore,
  observed as failureObserved,
  isFailure,
  isFactory,
  type Any as AnyFailure,
  type Failure as FailureOf,
  type FailureFactory,
  type FailureOptions as FailureBuildOptions,
} from '../result/failure.ts';

/**
 * The zero-parameter shape: return the value (or a promise of it) and that settles the Task.
 * Declared with no parameters both because that is what it receives and because it is what
 * lets TypeScript tell a recipe from an {@link Executor} — a lambda naming even one parameter
 * can then only be the executor, so `resolve` gets contextually typed instead of `any`.
 * A recipe that needs the `AbortSignal` takes the executor shape.
 */
export type Recipe<T> = () => T | PromiseLike<T>;

/**
 * The `new Promise` shape, made lazy: settle imperatively through `resolve`/`reject`, with the
 * Task's `AbortSignal` third.
 *
 * Returning a **promise** settles the Task as well (whichever lands first wins), which is what
 * lets `(_, __, signal) => fetch(url, { signal })` skip the resolver entirely. Any **other**
 * return value is ignored, exactly as `new Promise` ignores it — otherwise the commonest
 * executor idiom of all, `(resolve) => setTimeout(resolve, 100)`, would settle the Task
 * instantly with a timer handle. To settle with something that might not be a promise, hand it
 * to the resolver: `(resolve) => resolve(maybeAPromise)`.
 *
 * Honouring the promise also closes a hole the platform leaves open: `new Promise(async () => {
 * throw x })` discards the executor's promise, so the throw escapes as an unhandled rejection
 * and the promise never settles. Here it simply becomes the Task's failure.
 */
export type Executor<T> = (
  resolve: (value: T | PromiseLike<T>) => void,
  reject: (reason?: unknown) => void,
  signal: AbortSignal,
) => unknown;

/**
 * The deadline in {@link TaskClass#await} elapsed before the work settled.
 *
 * ```ts
 * AwaitTimeout({ ms: 5000 }).message; // 'await timed out after 5000ms'
 * ```
 */
export const AwaitTimeout: FailureFactory<'AwaitTimeout', { ms: number }> = defineFailure(
  'AwaitTimeout',
  (data: { ms: number }) => `await timed out after ${data.ms}ms`,
);

/**
 * {@link TaskClass#shutdown} settled the Task because the caller asked it to stop.
 *
 * ```ts
 * Shutdown.is(Shutdown()); // true
 * ```
 */
export const Shutdown: FailureFactory<'Shutdown', undefined> &
  ((data?: undefined, options?: FailureBuildOptions) => FailureOf<'Shutdown', undefined>) =
  defineFailure('Shutdown', 'task shut down');

/**
 * A {@link TaskClass#retry} attempt nothing will await again — the reason its signal fires.
 *
 * ```ts
 * Abandoned.is(Abandoned()); // true
 * ```
 */
export const Abandoned: FailureFactory<'Abandoned', undefined> &
  ((data?: undefined, options?: FailureBuildOptions) => FailureOf<'Abandoned', undefined>) =
  defineFailure('Abandoned', 'retry moved on from this attempt');

/**
 * The failure a combinator member declares — `never` for a plain promise, which declares none.
 * Lets `Task.all`/`Task.race` union their members' `E` instead of widening it away, so a
 * combined Task still reads as `Task<T, TheFailureYouDeclared>`.
 */
type DeclaredFailureOf<T> = T extends TaskClass<unknown, infer E> ? E : never;

/**
 * `Task<T, E>` — a **lazy, retryable** superset of `Promise<T>` for error handling that respects
 * JavaScript's rules from the ground up. `E` is the *declared* failure type: the reason a caller
 * expects when it fails, and what {@link TaskClass#result} surfaces as the `Err`. It is advisory
 * (JS rejections are untyped, so `await` still throws `unknown`) but self-documenting — a
 * `Task<Config, ConfigFailure>` reads like a `Result<Config, ConfigFailure>` signature did, and
 * `.result()` settles to the bare `Result<T, E>` union — the value itself, or the typed
 * `Failure` — which one `Failure.is()` check discriminates.
 *
 * A `Task` is a real `Promise` (`instanceof Promise` holds, and the Promises/A+ suite passes —
 * see test/task/promises-aplus.ts) built from **work** — a {@link Recipe} `() => value`, an
 * {@link Executor} `(resolve, reject, signal) => …`, or a promise already running — that starts
 * **only when the Task is first awaited** (or `.then`-ed, or {@link TaskClass#perform}-ed).
 * A failure is a real **rejection** whose reason is a `Failure`. Those two choices are what make
 * it work *with* the language:
 *
 *  - `await task` returns the value or throws — the JS standard, so `.then`/`.map`/`Promise.all`
 *    all see the *value*, never a wrapper. (Making `await` yield `{ ok, value, error }` would
 *    force every native method to see the wrapper too — the neverthrow trade-off, rejected. The
 *    wrapper shape lives behind one method, {@link TaskClass#result}.)
 *  - `Promise.all`/`race`/`any` fail-fast; `try`/`catch` handles it; `instanceof Promise` holds.
 *  - Because it is lazy, a relationship accessor can fire its RPC only on `await`; because every
 *    Task keeps its work **and its derivation lineage**, {@link TaskClass#retry}/
 *    {@link TaskClass#restart} spawn fresh executions of the *whole chain* — including a
 *    combinator's members (the ember-concurrency model: a Promise instance settles once, but the
 *    Task re-runs). `retry` takes a delay, or a function of the attempt for backoff, and can
 *    bound each attempt; every attempt it abandons has its `AbortSignal` fired so subscriptions
 *    can be released.
 *
 * The two-tier rule threads through every consuming method: a **declared failure** (a `Failure`)
 * is an outcome the caller planned for, a **bug** (any other rejection) is not. `result`,
 * `match`, `unwrapOr` and `context` act only on declared failures and let bugs keep flying to the
 * one boundary that turns them into a crash report; `mapErr` (the adapter edge, where foreign
 * errors get classified *into* Failures) and `recover` (the crash boundary itself) are the two
 * deliberate catch-alls. `mapErr` takes a {@link define}d factory directly — `mapErr(Unreadable,
 * { path })` — chaining the original under `cause`, or a `(cause) => Failure` function when the
 * payload has to be read out of the error being classified.
 *
 * Construction takes work in whichever shape it already has — a {@link Recipe} (`() => value`),
 * an {@link Executor} (`(resolve, reject, signal) => …`, the `new Promise` shape made lazy), or
 * a promise that is already running — with or without `new`, since the exported value is
 * call-or-construct like `Boolean`/`Date`. The executor's parameters are ordered exactly as the
 * platform's, so an existing `new Promise` body can move into a Task unchanged, with the
 * `AbortSignal` appended where the platform has nothing:
 *
 * ```ts
 * import { define, type Of } from '../result/failure.ts';
 * const GitScanFailed = define('GitScanFailed', (d: { root: string }) => `scan failed: ${d.root}`);
 * type GitScanFailure = Of<typeof GitScanFailed>;
 * type ChangeScan = { scope: 'everything' } | { scope: 'paths'; paths: Set<string> };
 * const runGit = async (root: string): Promise<string> => `M ${root}/lib/a.ts`;
 * const classify = (error: unknown): GitScanFailure => GitScanFailed({ root: '.' }, { cause: error });
 * const parse = (out: string): ChangeScan => ({ scope: 'paths', paths: new Set(out.split('\n')) });
 *
 * function scanChanges(root: string): Task<ChangeScan, GitScanFailure> {
 *   return Task(() => runGit(root)).mapErr(classify).map(parse);
 * }
 * ```
 *
 * @see docs/error-handling.md
 */
class TaskClass<T, E = AnyFailure> extends Promise<T> {
  /** The work. Runs at most once per instance (memoised); kept so retry/restart can re-run it.
   *  Either a **recipe** (`() => value`) or an **executor** (`(resolve, reject, signal) => …`),
   *  told apart by declared arity — see {@link TaskClass#constructor}. */
  #work: Recipe<T> | Executor<T>;
  #started = false;
  #controller: AbortController | undefined;
  /** Typed `unknown` rather than `T` on purpose. A private field is checked structurally, so
   *  putting `T` in a parameter position here would make the whole class INVARIANT in `T` —
   *  and `Task.fail(...)`, whose type is `Task<never, F>`, would stop being assignable to the
   *  `Task<Value, F>` a guard clause returns. Native Promise has no such field and stays
   *  covariant; this keeps Task the same. Only values this class produced ever reach it. */
  #resolve!: (value: unknown) => void;
  #reject!: (reason: unknown) => void;
  /** Derivation lineage: the Task this one was derived from, and how to re-derive it — what
   *  makes restart/retry on a *chain* re-execute the chain's source, not just the last step. */
  #source: TaskClass<unknown, unknown> | undefined;
  /** A combinator's members, kept so cancellation reaches them — lineage for a task with many
   *  sources rather than one. Undefined on every non-combinator Task. */
  #members: (() => readonly unknown[]) | undefined;
  #rederive: ((fresh: TaskClass<unknown, unknown>) => TaskClass<T, E>) | undefined;
  /** Rebuilds a combinator over freshly restarted members. A combinator has no single source
   *  to walk, so this is how `restart` reaches the work its members represent. */
  #remake: (() => TaskClass<T, E>) | undefined;

  /**
   * Takes any of the three shapes work arrives in — all lazy, all identical with or without
   * `new`:
   *
   * - **recipe**, declaring no parameters — `() => value`, `async () => value`. Whatever it
   *   returns (value or promise) settles the Task. The common case.
   * - **executor**, declaring at least one — `(resolve, reject, signal) => …`, the
   *   `new Promise` shape, so callback/event APIs settle a Task imperatively. Unlike
   *   `new Promise` it runs **lazily** (on first await/`perform`), gets an `AbortSignal` third
   *   for {@link TaskClass#shutdown}, and re-runs with *fresh* resolvers on every
   *   {@link TaskClass#restart}. A returned promise settles the Task too, so
   *   `(_, __, signal) => fetch(url, { signal })` needs no resolver call at all.
   * - **promise**, already running — the Task then defers only *observation*.
   *
   * The two function shapes are told apart by **declared arity** (`fn.length`), which is why
   * an executor must name at least `resolve`. `(...args) => …` and defaulted first parameters
   * both declare zero, so they read as recipes — spell the parameters out to get an executor.
   */
  constructor(source: PromiseLike<T> | Recipe<T> | Executor<T>) {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason: unknown) => void;
    // A no-op executor: the work does not start here (that is the whole point). We only capture
    // the resolving functions; `#work` runs later, in `#start`, on the first `.then`.
    super((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A promise source becomes a zero-parameter recipe, so `#work`'s own arity stays the
    // single source of truth for which shape it is — nothing extra to store, and nothing to
    // keep in sync when `restart()` carries the work to a fresh Task.
    this.#work = typeof source === 'function' ? (source as Recipe<T> | Executor<T>) : () => source;
    this.#resolve = resolve as (value: unknown) => void;
    this.#reject = reject;
  }

  /**
   * `.then` derives plain Promises, not Tasks — a derived promise has no recipe, and its
   * constructor would be called with an executor, not a recipe. The chaining methods build real
   * (lazy) Tasks explicitly instead.
   */
  static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  #start(): void {
    if (this.#started) return;
    this.#started = true;
    const work = this.#work;
    try {
      if (work.length === 0) {
        // The common shape. A recipe declares no parameters, so it can never observe the
        // signal — the AbortController is left uncreated until `shutdown` actually asks for
        // one, which keeps the ordinary path free of it entirely.
        Promise.resolve((work as Recipe<T>)()).then(this.#resolve, this.#reject);
      } else {
        // The executor settles THIS Task's own resolvers — no intermediate promise, so the
        // imperative shape costs less than the `new Promise` it replaces. A returned promise
        // is honoured as well; whichever settles first wins, as promises always do.
        this.#controller ??= new AbortController();
        const returned = (work as Executor<T>)(
          this.#resolve,
          this.#reject,
          this.#controller.signal,
        );
        if (isThenable<T>(returned)) returned.then(this.#resolve, this.#reject);
      }
    } catch (error) {
      // A synchronous throw from the work becomes the rejection, same as an async one.
      this.#reject(error);
    }
  }

  /**
   * Runs the recipe on first await/then. This is the single trigger point for the lazy work —
   * `catch` and `finally` route through it too, since both call `then` per spec.
   *
   * The signature mirrors `Promise.prototype.then` exactly (including `reason: any`, which the
   * lib.d.ts declaration uses) so the subclass stays assignable everywhere a Promise is.
   *
   * ```ts
   * const task = Task(() => [{ name: 'ada' }]);
   *
   * const names = task.then((users) => users.map((u) => u.name)); // plain Promise out
   * await names; // ['ada'] — to stay in Task-land (lazy, retryable, typed E), use .map instead
   * ```
   */
  override then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    // deno-lint-ignore no-explicit-any
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    this.#start();
    return super.then(onfulfilled, onrejected);
  }

  /**
   * `Promise.prototype.finally`, returning a **Task** so cleanup does not drop the chain into
   * plain-Promise land. Every spec behaviour is kept: `onFinally` takes no arguments, its return
   * value is discarded, a thenable it returns is awaited, and anything it throws replaces the
   * outcome.
   *
   * **Prefer `try`/`finally` to this.** It exists so that calling it on a Task — which is a real
   * Promise, so anyone may — behaves sensibly, not because it is the better spelling. A plain
   * `try`/`finally` inside the recipe is better on every axis:
   *
   * ```ts
   * const acquire = async () => ({ read: async () => 'body', release: () => {} });
   *
   * // preferred: lazy, retryable, and the cleanup runs once per attempt
   * Task(async () => {
   *   const handle = await acquire();
   *   try {
   *     return await handle.read();
   *   } finally {
   *     handle.release();
   *   }
   * });
   * ```
   *
   * The reason is that this method must be EAGER — `finally` is overwhelmingly written
   * fire-and-forget (`closeWithGrace(...).finally(() => process.exit(143))`), and a lazy one
   * nobody awaited would never release. Being eager, it hands back a *running* Task, so
   * `task.finally(cleanup).retry(3)` leaves the first attempt's rejection unowned and reports an
   * unhandled rejection. `retry` first, `finally` last — or `try`/`finally`, which cannot be held
   * wrong this way.
   *
   * ```ts
   * let released = false;
   * const value = await Task(() => 'body').finally(() => {
   *   released = true; // runs whichever way the Task settles
   * });
   *
   * value; // 'body' — the outcome passes through untouched
   * released; // true
   * ```
   */
  override finally(onFinally?: (() => void) | null): TaskClass<T, E> {
    return this.#derive<T, E>(
      () => super.finally(onFinally),
      (fresh) => fresh.finally(onFinally),
    ).perform();
  }

  /**
   * Starts the run **now** without suspending the caller (ember-concurrency's verb), so work
   * can overlap: `task.perform()` early, `await task` later joins the in-flight run. Idempotent
   * — on a running or settled Task it is a no-op join. Returns `this` for chaining.
   *
   * An unconsumed performed Task that fails becomes an unhandled rejection, exactly like any
   * un-awaited promise — perform-and-forget still wants a `.result()` or a `recover` somewhere.
   *
   * ```ts
   * const scanChanges = (root: string, ref: string) => Task(() => new Set([root, ref]));
   * const buildFsTree = async (config: object): Promise<object> => config;
   *
   * const scan = scanChanges('.', 'HEAD').perform(); // git starts NOW
   * const tree = await buildFsTree({}); // overlapped work
   * const changes = await scan; // join the in-flight run — no second git call
   * ```
   */
  perform(): this {
    this.#start();
    return this;
  }

  /**
   * Awaits the task with a deadline — Elixir's `Task.await/2` (default 5000ms). Starts the
   * run if needed; rejects with a declared `Failure('AwaitTimeout')` when the deadline fires
   * first. The deadline does NOT cancel the work ({@link TaskClass#shutdown} does) — a later
   * `await task` can still join the run, exactly like Elixir's yield-after-timeout.
   *
   * ```ts
   * await Task(() => 42).await(1000); // 42
   * const slow = Task(() => new Promise<never>(() => {}));
   * const failed = await slow.await(10).catch((e) => e);
   * (failed as { code: string }).code; // 'AwaitTimeout'
   * ```
   */
  await(timeoutMs = 5000): Promise<T> {
    this.#start();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(AwaitTimeout({ ms: timeoutMs })), timeoutMs);
      // No unref: the deadline must HOLD the event loop (an unref'd timer lets Deno's
      // test sanitizer — and a bare Node script — drain the loop mid-wait); clearTimeout on
      // settle releases it immediately anyway.
    });
    return Promise.race([this, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
  }

  /**
   * Non-destructive poll — Elixir's `Task.yield/2`: settles to the task's `Result` if it
   * finishes within the window, or `null` if it is still running. Never consumes: the memo
   * persists, so a later `yield`, `await`, or `result()` still sees the outcome. A *bug*
   * rejection still rethrows (the two-tier gate is `result()`'s).
   *
   * ```ts
   * const task = Task(() => 7);
   * await task.yield(50); // 7 — settled within the window, bare
   * const slow = Task(() => new Promise<never>(() => {}));
   * await slow.yield(10); // null — still running, NOT consumed
   * ```
   */
  yield(timeoutMs = 5000): Promise<Result<T, E> | null> {
    this.#start();
    let timer: ReturnType<typeof setTimeout>;
    const window = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    return Promise.race([this.result(), window]).finally(() => clearTimeout(timer));
  }

  /**
   * Aborts the run and reports what was there — Elixir's `Task.shutdown/2`. Fires the
   * {@link Executor}'s AbortSignal, so work that was handed it — a `fetch(url, { signal })` —
   * stops; JS cannot preempt work that ignores it, which finishes detached. Then yields for
   * `timeoutMs`: the settled `Result` if one landed, else `null` after settling the task
   * with a declared `Failure('Shutdown')` so every consumer resolves.
   *
   * A {@link Recipe} declares no parameters and so never sees the signal — it cannot be
   * interrupted, only abandoned. Take the executor shape for work that should stop.
   *
   * ```ts
   * const slow = Task<number>((resolve, _reject, signal) => {
   *   const timer = setTimeout(() => resolve(1), 60_000);
   *   signal.addEventListener('abort', () => clearTimeout(timer));
   * });
   * slow.perform();
   *
   * await slow.shutdown(10); // null — nothing had landed, and the timer was cleared
   * ```
   */
  async shutdown(timeoutMs = 5000): Promise<Result<T, E> | null> {
    const marker = Shutdown();
    if (!this.#started) {
      // Never ran: settle as shut down without ever invoking the work.
      this.#started = true;
      this.#controller ??= new AbortController();
      this.#reject(marker);
    } else {
      this.#abort(marker);
    }
    const settled = await this.yield(timeoutMs).catch(() => null); // a bug counts as settled-nothing here
    if (settled === null) this.#reject(marker); // work that ignored the signal: settle consumers anyway
    // The marker settling is OUR doing, not a reply — Elixir's shutdown says nil for that.
    return settled === (marker as unknown) ? null : settled;
  }

  // ── Builders ─────────────────────────────────────────────────────────────────

  /**
   * The call boundary with arguments — `Promise.try`'s shape, made lazy: `fn(...args)` runs on
   * first await, and whatever it throws (sync or async) becomes the rejection. The closure the
   * caller would otherwise write by hand (`Task(() => fn(a, b))`) is built here instead.
   *
   * ```ts
   * const runGit = async (args: string[], cwd: string) => `ran git ${args[0]} in ${cwd}`;
   *
   * const scan = Task.try(runGit, ['status', '--porcelain'], '.'); // lazy, args captured
   * await scan.retry(2); // three fresh runGit executions at most
   * ```
   */
  static override try<T, A extends unknown[]>(
    fn: (...args: A) => T | PromiseLike<T>,
    ...args: A
  ): TaskClass<Awaited<T>> {
    return new TaskClass(() => fn(...args)) as TaskClass<Awaited<T>>;
  }

  /**
   * A resolved Task. Overridden because the inherited `Promise.resolve` builds via
   * `new this(executor)`, which our lazy constructor cannot satisfy — it stores the work
   * rather than running it, so `NewPromiseCapability` never captures its resolvers. Same for
   * every other inherited static (`try` above, `reject`/`withResolvers`/the combinators below).
   *
   * A Task passes straight through, as `Promise.resolve` passes a same-constructor promise
   * through: wrapping one would hand back something whose `restart` re-awaits a settled inner
   * Task instead of re-running its work, which is the lineage a Task exists to keep.
   *
   * ```ts
   * await Task.resolve(42); // 42 — a settled value lifted into Task-land
   * ```
   */
  static override resolve(): TaskClass<void>;
  static override resolve<T>(value: T | PromiseLike<T>): TaskClass<Awaited<T>>;
  static override resolve<T>(value?: T | PromiseLike<T>): TaskClass<Awaited<T>> {
    if (value instanceof TaskClass) return value as TaskClass<Awaited<T>>;
    return new TaskClass(() => value as Awaited<T>);
  }

  /**
   * A rejected Task, spec-shaped (`reason` erased to `unknown`). Prefer {@link TaskClass.fail},
   * which keeps the reason's type as the Task's declared `E`.
   *
   * ```ts
   * import assert from 'node:assert';
   *
   * await assert.rejects(Task.reject(new Error('boom')), /boom/);
   * ```
   */
  static override reject<T = never>(reason?: unknown): TaskClass<T> {
    return new TaskClass<T>(() => Promise.reject(reason));
  }

  /**
   * A Task that fails with `reason` (a rejection — so `await` throws it), typed: the declared
   * `E` is exactly `reason`'s type.
   *
   * ```ts
   * import { define } from '../result/failure.ts';
   * const Denied = define('Denied', (d: { user: string }) => `denied: ${d.user}`);
   *
   * const denied = Task.fail(Denied({ user: 'root' })); // Task<never, Failure<'Denied', …>>
   * (await denied.result()).code; // 'Denied' — the failure arrives bare, typed end to end
   * ```
   */
  static fail<F>(reason: F): TaskClass<never, F> {
    return new TaskClass<never, F>(() => Promise.reject(reason));
  }

  /**
   * Elixir's `Task.async/1`: build the task AND start it now — the async half of the
   * async/await pair, for running work concurrently with the code that follows.
   *
   * ```ts
   * const a = Task.async(() => 2);
   * const b = Task.async(() => 3); // both running before either is awaited
   * (await a.await()) + (await b.await()); // 5
   * ```
   */
  static async<T, E = AnyFailure>(source: Recipe<T> | Executor<T>): TaskClass<T, E> {
    return new TaskClass<T, E>(source).perform();
  }

  /**
   * Elixir's `Task.completed/1`: an already-settled task — for handing a precomputed value
   * to an API that expects a Task, with no recipe left to run.
   *
   * ```ts
   * await Task.completed(42); // 42
   * await Task.completed(42).yield(0); // 42 — settled before any window
   * ```
   */
  static completed<T>(value: T): TaskClass<Awaited<T>, never> {
    return (TaskClass.resolve(value) as TaskClass<Awaited<T>, never>).perform();
  }

  /**
   * Elixir's `Task.await_many/2`: awaits every task under ONE shared deadline, positionally.
   *
   * ```ts
   * await Task.awaitMany([Task(() => 1), Task(() => 2)], 1000); // [1, 2]
   * ```
   */
  static awaitMany<T, E>(tasks: readonly TaskClass<T, E>[], timeoutMs = 5000): Promise<T[]> {
    return new TaskClass<T[], E>(() => Promise.all(tasks)).await(timeoutMs);
  }

  /**
   * Elixir's `Task.yield_many/2`: polls every task under one shared window — each slot is
   * the task's `Result` if it settled in time, `null` if still running. Nothing is consumed.
   *
   * ```ts
   * const fast = Task(() => 1);
   * const never = Task<number>(() => new Promise<never>(() => {}));
   * await Task.yieldMany([fast, never], 20); // [1, null] — bare Result | null per slot
   * ```
   */
  static yieldMany<T, E>(
    tasks: readonly TaskClass<T, E>[],
    timeoutMs = 5000,
  ): Promise<(Result<T, E> | null)[]> {
    return Promise.all(tasks.map((task) => task.yield(timeoutMs)));
  }

  /**
   * `Promise.withResolvers`, returning a Task settled from outside. Lazy like every method
   * but `ignore`: the Task only *observes* the external settlement once something awaits it.
   *
   * ```ts
   * const socket = { once(_event: string, handler: (frame: string) => void) { handler('hi'); } };
   *
   * const { promise, resolve } = Task.withResolvers<string>();
   * socket.once('frame', resolve);
   * await promise; // fine even if the frame landed before this line
   * ```
   */
  static override withResolvers<T>(): {
    promise: TaskClass<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  } {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const settled = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise: new TaskClass<T>(() => settled), resolve, reject };
  }

  // ── Combinators — lazy versions of the Promise statics ──────────────────────
  //
  // All four are overridden for correctness (the base implementations construct through
  // `new this(executor)`, which a recipe constructor cannot honour) and made LAZY: nothing in
  // `values` is observed — and no lazy member Task starts — until the combined Task is awaited.
  //
  // They also carry lineage the only way a combinator can. A derived Task walks back to one
  // source; a combinator has many, so `restart` rebuilds it over freshly restarted members and
  // `retry` therefore retries the work rather than re-reading settled answers. Members that are
  // plain promises are passed through — already running, with no second execution to give.

  /**
   * Lazy `Promise.all`: on await, everything starts together, resolves positionally, and
   * fail-fast applies — before the await, nothing has begun.
   *
   * The combined Task keeps the members' declared failure — `Task.all` of two
   * `Task<T, LoadFailure>` is a `Task<T[], LoadFailure>`, so `.result()` on it still
   * discriminates the union you declared rather than a widened `Failure`.
   *
   * ```ts
   * const both = Task.all([Task(() => 'a'), Task(() => 'b')]); // nothing has started yet
   * await both; // ['a', 'b'] — both started HERE
   * ```
   */
  static override all<T extends readonly unknown[] | []>(
    values: T,
  ): TaskClass<{ -readonly [P in keyof T]: Awaited<T[P]> }, DeclaredFailureOf<T[number]>>;
  static override all<T, E>(values: Iterable<TaskClass<T, E>>): TaskClass<Awaited<T>[], E>;
  static override all<T>(values: Iterable<T | PromiseLike<T>>): TaskClass<Awaited<T>[]>;
  static override all(values: Iterable<unknown>): TaskClass<unknown[]> {
    const members = snapshotOnce(values);
    const task = new TaskClass(() => Promise.all(members()));
    task.#remake = () => TaskClass.all(members().map(restarted));
    task.#members = members;
    return task;
  }

  /**
   * Lazy `Promise.race`: the first settlement — success or failure — wins.
   *
   * ```ts
   * await Task.race([Task(() => 'fast'), Task<string>(() => new Promise<never>(() => {}))]);
   * // 'fast'
   * ```
   */
  static override race<T extends readonly unknown[] | []>(
    values: T,
  ): TaskClass<Awaited<T[number]>, DeclaredFailureOf<T[number]>>;
  static override race<T, E>(values: Iterable<TaskClass<T, E>>): TaskClass<Awaited<T>, E>;
  static override race<T>(values: Iterable<T | PromiseLike<T>>): TaskClass<Awaited<T>>;
  static override race(values: Iterable<unknown>): TaskClass<unknown> {
    const members = snapshotOnce(values);
    const task = new TaskClass(() => Promise.race(members()));
    task.#remake = () => TaskClass.race(members().map(restarted));
    task.#members = members;
    return task;
  }

  /**
   * Lazy `Promise.any`: the first SUCCESS wins; failures only lose.
   *
   * ```ts
   * await Task.any([Task.reject(new Error('x')), Task(() => 'ok')]); // 'ok'
   * ```
   */
  static override any<T extends readonly unknown[] | []>(values: T): TaskClass<Awaited<T[number]>>;
  static override any<T>(values: Iterable<T | PromiseLike<T>>): TaskClass<Awaited<T>>;
  static override any(values: Iterable<unknown>): TaskClass<unknown> {
    const members = snapshotOnce(values);
    const task = new TaskClass(() => Promise.any(members()));
    task.#remake = () => TaskClass.any(members().map(restarted));
    task.#members = members;
    return task;
  }

  /**
   * Lazy `Promise.allSettled`, keeping the spec's `{ status, … }` shape — contrast
   * {@link TaskClass.results}, which yields typed `Result`s instead.
   *
   * ```ts
   * const settled = await Task.allSettled([Task(() => 1), Task.reject(new Error('x'))]);
   * settled.map((s) => s.status); // ['fulfilled', 'rejected']
   * ```
   */
  static override allSettled<T extends readonly unknown[] | []>(
    values: T,
  ): TaskClass<{ -readonly [P in keyof T]: PromiseSettledResult<Awaited<T[P]>> }>;
  static override allSettled<T>(
    values: Iterable<T | PromiseLike<T>>,
  ): TaskClass<PromiseSettledResult<Awaited<T>>[]>;
  static override allSettled(
    values: Iterable<unknown>,
  ): TaskClass<PromiseSettledResult<unknown>[]> {
    const members = snapshotOnce(values);
    const task = new TaskClass(() => Promise.allSettled(members()));
    task.#remake = () => TaskClass.allSettled(members().map(restarted));
    task.#members = members;
    return task;
  }

  /**
   * Awaits every task and returns their outcomes **positionally** — index-preserving, so a batch
   * knows *which* input failed, and no success is discarded (unlike `Promise.all`'s fail-fast).
   * The errors are the declared `E`; a *bug* in any task rejects the whole call, matching
   * {@link TaskClass#result}'s two-tier rule. (Named `results`, not `allSettled`, which is the
   * inherited static with the spec's `{ status, … }` shape.)
   *
   * ```ts
   * import { partition } from '../result/result.ts';
   * import type { Any as LoadFailure } from '../result/failure.ts';
   * const paths = ['a.json', 'b.json'];
   * const load = (path: string) => Task<object, LoadFailure>(() => ({ path }));
   *
   * const outcomes = await Task.results(paths.map(load)); // (object | LoadFailure)[] — bare unions
   * const { values, errors } = partition(outcomes); // nothing lost, everything typed
   * ```
   */
  static results<T, E = AnyFailure>(
    tasks: Iterable<TaskClass<T, E> | PromiseLike<T>>,
  ): TaskClass<Result<T, E>[], never> {
    const members = snapshotOnce(tasks);
    const combined = new TaskClass<Result<T, E>[], never>(
      () =>
        Promise.all(members().map((task) => new TaskClass<T, E>(task).result())) as Promise<
          Result<T, E>[]
        >,
    );
    combined.#remake = () => TaskClass.results(members().map(restarted));
    return combined;
  }

  // ── Data-first twins of every transforming method ────────────────────────────
  //
  // `Task.map(task, fn)` ≡ `task.map(fn)`, for each method below — the Elixir-style module
  // function spelling, kept pipeline-operator-ready (a future `task |> Task.map(%, fn)` needs
  // the module function to exist). Each is pure delegation: same laziness, same lineage, same
  // two-tier rule; the receiver simply moves to the first argument, so the twin law
  // `Task.m(t, …) === t.m(…)` holds by construction. `then` stays instance-only (the Promise
  // contract) and `ignore` already has its source-accepting static below.

  /**
   * Data-first twin of {@link TaskClass#map}.
   *
   * ```ts
   * const upper = Task.map(Task(() => 'fetched'), (s) => s.toUpperCase());
   * ```
   */
  static map<T, E, U>(
    task: TaskClass<T, E>,
    fn: (value: T) => U | PromiseLike<U>,
  ): TaskClass<U, E> {
    return task.map(fn);
  }

  /**
   * Data-first twin of {@link TaskClass#ensure} — the invariant, receiver-first.
   *
   * ```ts
   * import { define } from '../result/failure.ts';
   * const Empty = define('Empty', 'no rows');
   *
   * const rows = Task(() => [1, 2]);
   * await Task.ensure(rows, (r) => r.length > 0, () => Empty()); // [1, 2]
   * ```
   */
  static ensure<T, E, F extends AnyFailure>(
    task: TaskClass<T, E>,
    predicate: (value: T) => boolean,
    toFailure: (value: T) => F,
  ): TaskClass<T, E | F> {
    return task.ensure(predicate, toFailure);
  }

  /**
   * Data-first twin of {@link TaskClass#mapErr} — the adapter edge, receiver-first.
   *
   * ```ts
   * import { define } from '../result/failure.ts';
   * const Classified = define('Classified', (d: { op: string }) => `failed: ${d.op}`);
   *
   * const t = Task.mapErr(Task(() => 'ok'), (cause) => Classified({ op: 'io' }, { cause }));
   * await t; // 'ok' — success passes through untouched
   * ```
   */
  static mapErr<T, E, F>(task: TaskClass<T, E>, fn: (error: unknown) => F): TaskClass<T, F> {
    return task.mapErr(fn);
  }

  /**
   * Data-first twin of {@link TaskClass#recover} — the crash boundary, receiver-first.
   *
   * ```ts
   * await Task.recover(Task.reject<string>(new Error('boom')), () => 'safe'); // 'safe'
   * ```
   */
  static recover<T, E, U = T>(
    task: TaskClass<T, E>,
    fn: (error: unknown) => U | PromiseLike<U>,
  ): TaskClass<T | U, never> {
    return task.recover(fn);
  }

  /**
   * Data-first twin of {@link TaskClass#context} — context for declared failures only.
   *
   * ```ts
   * await Task.context(Task(() => 'v'), 'must load'); // 'v' — context only decorates failures
   * ```
   */
  static context<T, E>(task: TaskClass<T, E>, message: string): TaskClass<T, E> {
    return task.context(message);
  }

  /**
   * Data-first twin of {@link TaskClass#unwrapOr} — fallback for declared failures only.
   *
   * ```ts
   * import { define } from '../result/failure.ts';
   * const Missing = define('Missing', 'missing');
   *
   * await Task.unwrapOr(Task.fail(Missing()), 'fallback'); // 'fallback'
   * ```
   */
  static unwrapOr<T, E, U>(task: TaskClass<T, E>, fallback: U): TaskClass<T | U, never> {
    return task.unwrapOr(fallback);
  }

  /**
   * Data-first twin of {@link TaskClass#match} — both declared branches, bugs keep flying.
   *
   * ```ts
   * await Task.match(Task(() => 2), { ok: (n) => n * 21, err: () => 0 }); // 42
   * ```
   */
  static match<T, E, A, B>(
    task: TaskClass<T, E>,
    handlers: { ok: (value: T) => A | PromiseLike<A>; err: (error: E) => B | PromiseLike<B> },
  ): TaskClass<A | B, never> {
    return task.match(handlers);
  }

  /**
   * Data-first twin of {@link TaskClass#perform} — start now, hand the same task back.
   *
   * ```ts
   * const started = Task.perform(Task(() => 'now')); // running already
   * await started; // 'now'
   * ```
   */
  static perform<T, E>(task: TaskClass<T, E>): TaskClass<T, E> {
    return task.perform();
  }

  /**
   * Data-first twin of {@link TaskClass#restart} — a fresh execution of the whole chain.
   *
   * ```ts
   * let runs = 0;
   * const t = Task(() => ++runs);
   * await t; // 1
   * await Task.restart(t); // 2 — a fresh execution
   * ```
   */
  static restart<T, E>(task: TaskClass<T, E>): TaskClass<T, E> {
    return task.restart();
  }

  /**
   * Data-first twin of {@link TaskClass#retry} — fresh restarts until success.
   *
   * ```ts
   * let tries = 0;
   * const flaky = Task(() => {
   *   if (++tries < 2) throw new Error('again');
   *   return tries;
   * });
   * await Task.retry(flaky); // 2
   * await Task.retry(flaky, 3, { delayMs: 1 }); // the instance method's options, unchanged
   * ```
   */
  static retry<T, E>(
    task: TaskClass<T, E>,
    times = 1,
    options: RetryDelay | RetryOptions = {},
  ): TaskClass<T, E> {
    return task.retry(times, options);
  }

  /**
   * Data-first twin of {@link TaskClass#result} — the bridge to the bare `Result` union.
   *
   * Takes a foreign promise as well as a Task, matching {@link TaskClass.results} and the
   * constructor: this twin is most useful over a value someone handed you, and being handed a
   * promise is the ordinary case. A promise is lifted first, so its rejection lands on the
   * failure channel exactly as a Task's would.
   *
   * ```ts
   * const value = await Task.result(Task(() => 21 * 2)); // 42 — or the declared Failure, bare
   * await Task.result(Promise.resolve(7)); // 7 — a foreign promise needs no wrapping first
   * ```
   */
  static result<T, E>(task: TaskClass<T, E> | PromiseLike<T>): TaskClass<Result<T, E>, never> {
    return (task instanceof TaskClass ? task : new TaskClass<T, E>(task)).result();
  }

  // ── Transforming — lazy, and each returns a real Task ────────────────────────
  //
  // Every method derives a fresh `Task(() => this.then(...))`: the `this.then` inside the recipe
  // triggers the upstream Task — but only when the *derived* Task is awaited, so a chain like
  // `task.map(f).context(m)` stays fully lazy, and repeated awaits share the upstream's memoised
  // run. `#derive` also records the lineage that lets restart/retry re-execute the whole chain.

  #derive<U, F>(
    recipe: () => U | PromiseLike<U>,
    rederive: (fresh: TaskClass<T, E>) => TaskClass<U, F>,
  ): TaskClass<U, F> {
    const derived = new TaskClass<U, F>(recipe);
    derived.#source = this as TaskClass<unknown, unknown>;
    derived.#rederive = rederive as (fresh: TaskClass<unknown, unknown>) => TaskClass<U, F>;
    return derived;
  }

  /**
   * Transforms the success value — `.then(fn)` that stays a Task: lazy, retryable, `E` kept.
   * `fn` may return a value or a promise of one (they flatten), so this is `andThen` too.
   *
   * ```ts
   * const loadUser = (id: number) => Task(() => ({ name: 'u' + id }));
   *
   * loadUser(1).map((u) => u.name).map((n) => n.toUpperCase()); // still lazy, still a Task
   * ```
   */
  map<U>(fn: (value: T) => U | PromiseLike<U>): TaskClass<U, E> {
    return this.#derive(
      () => this.then(fn),
      (fresh) => fresh.map(fn),
    );
  }

  /**
   * Declares an invariant on the success value: the value passes through when `predicate`
   * holds, otherwise the Task rejects with the declared failure built **from the value** —
   * which is what makes it the one-line spelling of the HTTP envelope check:
   *
   * ```ts
   * import { define, is } from '../result/failure.ts';
   * const PageFailed = define('PageFailed', (d: { status: number }) => `page failed: HTTP ${d.status}`);
   * const respond = (status: number) => Task(() => new Response(null, { status }));
   *
   * const checked = await respond(404).ensure((res) => res.ok, (res) => PageFailed({ status: res.status })).result();
   * is(checked) && checked.code; // 'PageFailed' — declared, typed, one line
   * await respond(200).ensure((res) => res.ok, (res) => PageFailed({ status: res.status })).map((r) => r.status); // 200
   * ```
   */
  ensure<F extends AnyFailure>(
    predicate: (value: T) => boolean,
    toFailure: (value: T) => F,
  ): TaskClass<T, E | F> {
    return this.#derive<T, E | F>(
      () =>
        this.then((value) => {
          if (!predicate(value)) throw toFailure(value);
          return value;
        }),
      (fresh) => fresh.ensure(predicate, toFailure),
    );
  }

  /**
   * Transforms the failure reason — **the adapter edge**. This is the one transforming method
   * that sees *every* rejection (`error: unknown`), because its job is to classify foreign
   * errors — an `execFile` timeout, a driver throw — *into* the declared `Failure` taxonomy.
   * Downstream of a `mapErr`, the two-tier methods can trust what they see.
   *
   * ```ts
   * import { define } from '../result/failure.ts';
   * const GitScanFailed = define('GitScanFailed', (d: { ref: string }) => `scan failed: ${d.ref}`);
   * const execFileAsync = async (cmd: string, args: string[]) => `${cmd} ${args[0]}`;
   * const ref = 'HEAD';
   *
   * Task(() => execFileAsync('git', ['status'])) // foreign throw-land
   *   .mapErr((cause) => GitScanFailed({ ref }, { cause })); // classified HERE, once
   * ```
   *
   * A {@link define}d factory may be passed directly, with its payload as the second argument
   * — the original is chained under `cause` for you. Factories carry their own `code` and `is`,
   * so they are told from a mapper exactly rather than by arity:
   *
   * ```ts
   * import { define } from '../result/failure.ts';
   * const Unreadable = define('Unreadable', (d: { path: string }) => `cannot read ${d.path}`);
   * const Denied = define('Denied', 'permission denied');
   *
   * Task(() => Promise.reject(new Error('EACCES')))
   *   .mapErr(Unreadable, { path: '/etc/app.json' }); // payload given, cause chained
   * Task(() => Promise.reject(new Error('EACCES'))).mapErr(Denied); // no payload to give
   * ```
   *
   * Reach for the function form whenever the payload is read *from* the cause — the git scan
   * above takes its `reason` from the error's first line, which no shorthand can express.
   */
  mapErr<Code extends string, Data>(
    factory: FailureFactory<Code, Data>,
    data: Data,
  ): TaskClass<T, FailureOf<Code, Data>>;
  mapErr<Code extends string>(
    factory: FailureFactory<Code, undefined>,
  ): TaskClass<T, FailureOf<Code, undefined>>;
  mapErr<F>(fn: (error: unknown) => F): TaskClass<T, F>;
  mapErr(fnOrFactory: unknown, data?: unknown): TaskClass<T, unknown> {
    // Normalised once, here: everything downstream — including the re-derivation restart uses
    // — sees a plain mapper, so the factory shape exists only at the call site.
    const fn = isFactory(fnOrFactory)
      ? (cause: unknown) =>
          (fnOrFactory as unknown as (d: unknown, o: { cause: unknown }) => unknown)(data, {
            cause,
          })
      : (fnOrFactory as (error: unknown) => unknown);
    return this.#derive(
      () =>
        this.then(undefined, (error) => {
          throw fn(error);
        }),
      (fresh) => fresh.mapErr(fn),
    );
  }

  /**
   * Recovers by producing a success value — **the crash boundary**, the Task spelling of the
   * one `.catch()` at the top of a program. Sees every rejection, bugs included; everything
   * downstream is settled, so `E` is `never`.
   *
   * ```ts
   * const route = (_req: Request) => Task(() => new Response('ok'));
   * const internalError = () => new Response(null, { status: 500 });
   * const log = (value: unknown): void => console.debug(value);
   * const req = new Request('https://example.com/users/7');
   *
   * const reply = await route(req).recover((bug) => {
   *   log(bug);
   *   return internalError();
   * });
   * ```
   */
  recover<U = T>(fn: (error: unknown) => U | PromiseLike<U>): TaskClass<T | U, never> {
    return this.#derive<T | U, never>(
      () =>
        this.then<T | U, T | U>(undefined, (error: unknown) => {
          // recover sees bugs too, but only declared failures report to the observation
          // seam — a bug being *survived* here is still not a planned outcome.
          if (isFailure(error)) failureObserved(error);
          return fn(error);
        }),
      (fresh) => fresh.recover(fn),
    );
  }

  /**
   * Deliberate non-handling — the Task spelling of `promise.catch(Failure.ignore(reason))`.
   * Swallows **every** rejection (bugs included: this is for cleanup whose failure genuinely
   * has no consequence) and says so on stderr under `QUNITX_DEBUG` instead of vanishing.
   *
   * Unlike every other method this one **starts the task**: "the outcome does not matter" is
   * not a decision laziness can defer, and eager attachment is what keeps a fire-and-forget
   * call site from ever holding an unobserved rejection.
   *
   * ```ts
   * import { unlink } from 'node:fs/promises';
   *
   * Task(unlink('/tmp/qunitx-daemon.sock')).ignore('daemon socket unlink'); // fire and forget
   * await Task(unlink('/tmp/qunitx.lock')).ignore('daemon lock unlink'); // or join the cleanup
   * ```
   */
  ignore(reason: string): TaskClass<T | undefined, never> {
    const report = failureIgnore(reason);
    return this.#derive<T | undefined, never>(
      () =>
        this.then<T | undefined, undefined>(undefined, (error: unknown) => {
          report(error);
          return undefined;
        }),
      (fresh) => fresh.ignore(reason),
    ).perform();
  }

  /**
   * One-shot static spelling of {@link TaskClass#ignore} for a foreign promise or recipe —
   * the fire-and-forget cleanup idiom in a single call. (The one twin whose first argument
   * is a raw `PromiseLike` or recipe rather than a Task: ignore is a *terminal* verb usable
   * without ever holding a Task.)
   *
   * ```ts
   * import { unlink } from 'node:fs/promises';
   *
   * Task.ignore(unlink('/tmp/qunitx-daemon.sock'), 'daemon socket unlink');
   * ```
   */
  static ignore<T>(
    source: PromiseLike<T> | (() => T | PromiseLike<T>),
    reason: string,
  ): TaskClass<T | undefined, never> {
    return new TaskClass<T, AnyFailure>(source).ignore(reason);
  }

  /**
   * Adds context to a declared failure — anyhow's `.context()`. Named for what it does, and
   * deliberately NOT `expect`: `Result.expect` is Rust's, which PROMOTES a failure to a bug,
   * and one word meaning both "keep this handled" and "crash on this" is the confusion worth
   * spending a rename to avoid.
   * A `Failure` rethrows as a new Failure with the **same `code` and `data`** (so `E`, and every
   * `switch` on `code`, still hold), `message` as the context line, and the original chained
   * under `cause`. A *bug* passes through untouched: promoting it into the declared tier would
   * hide it from the boundary.
   *
   * ```ts
   * const loadUser = (id: number) => Task(() => ({ name: 'u' + id }));
   *
   * await loadUser(7).context('route /users/7 needs its user');
   * // and when loadUser rejects with Failure(NotFound), the await throws:
   * // Failure(NotFound): route /users/7 needs its user
   * //   caused by: Failure(NotFound): no user 7
   * ```
   */
  context(message: string): TaskClass<T, E> {
    return this.#derive<T, E>(
      () =>
        this.then(undefined, (error: unknown) => {
          if (!isFailure(error)) throw error;
          throw new Failure(error.code, message, error.data, { cause: error });
        }),
      (fresh) => fresh.context(message),
    );
  }

  /**
   * Substitutes `fallback` for a **declared** failure. A bug still rejects — a fallback that
   * absorbed a `TypeError` would be the silent-bug-hider the two-tier rule exists to prevent.
   *
   * Takes a **value**, not a thunk: `unwrapOr(() => x)` falls back to the function itself.
   * For a fallback computed from the failure, use `match({ ok: (v) => v, err: fn })` — same
   * two-tier gate, and `err` runs only when there is one.
   *
   * ```ts
   * const loadConfig = () => Task(() => ({ port: 8080 }));
   * const DEFAULTS = { port: 3000 };
   *
   * const config = await loadConfig().unwrapOr(DEFAULTS);
   * ```
   */
  unwrapOr<U>(fallback: U): TaskClass<T | U, never> {
    return this.#derive<T | U, never>(
      () =>
        this.then<T | U, T | U>(undefined, (error: unknown) => {
          if (!isFailure(error)) throw error;
          failureObserved(error);
          return fallback;
        }),
      (fresh) => fresh.unwrapOr(fallback),
    );
  }

  /**
   * Handles both declared branches — `err` receives the typed `E`, so it is two-tier like
   * {@link TaskClass#result}: a bug belongs to neither branch and keeps rejecting.
   *
   * ```ts
   * const deploy = () => Task(() => 'v2.1.0');
   * const statusFor = (_code: string) => 503;
   *
   * const status = await deploy().match({ ok: () => 201, err: (e) => statusFor(e.code) });
   * ```
   */
  match<A, B>(handlers: {
    ok: (value: T) => A | PromiseLike<A>;
    err: (error: E) => B | PromiseLike<B>;
  }): TaskClass<A | B, never> {
    return this.#derive<A | B, never>(
      () =>
        this.then<A | B, A | B>(handlers.ok, (error: unknown) => {
          if (!isFailure(error)) throw error;
          failureObserved(error);
          return handlers.err(error as E);
        }),
      (fresh) => fresh.match(handlers),
    );
  }

  // ── Retry / restart — fresh executions of the whole chain ────────────────────

  /**
   * A brand-new execution: fresh recipe run for a root Task, and for a *derived* Task the
   * lineage is walked — the source restarts and every derivation step is re-applied. So
   * `scan.map(parse).context(ctx).restart()` re-runs the git call, the parse, and the context
   * wrap; nothing is served from the old chain's memo.
   *
   * ```ts
   * const chain = Task(() => 'fetched').map((s) => s.toUpperCase());
   *
   * await chain; // ran once, memoised
   * await chain.restart(); // fresh source execution, every derivation re-applied
   * await chain; // the original still serves its memo
   * ```
   */
  restart(): TaskClass<T, E> {
    if (this.#source !== undefined && this.#rederive !== undefined) {
      return this.#rederive(this.#source.restart());
    }
    if (this.#remake !== undefined) return this.#remake();
    // The work is copied across rather than re-passed through the constructor: an executor
    // normalised once must not be re-sniffed by arity. A fresh Task means fresh resolvers, so
    // a resolver captured by the previous attempt can only ever settle the attempt it came
    // from — a stale callback cannot cross-settle this one.
    const fresh = new TaskClass<T, E>(EMPTY_RECIPE as unknown as Recipe<T>);
    fresh.#work = this.#work;
    return fresh;
  }

  /**
   * Re-runs until success, spawning a fresh {@link TaskClass#restart} execution per attempt —
   * the first attempt included, so a Task that already ran and failed retries cleanly. Gives up
   * after `times` retries (initial + `times` executions) and rejects with the last reason.
   * Failure-blind by design: transient bugs (a socket reset surfacing as a raw error before its
   * `mapErr`) are exactly what call sites retry, so every rejection counts as an attempt.
   *
   * An attempt that fails is then **abandoned**: its `AbortSignal` fires so an executor that
   * subscribed to something can unsubscribe, rather than leaving a listener behind per attempt.
   * The attempt has already settled, so this changes no outcome and its reason never reaches
   * the caller — the failure they see is their own. Recipes take no signal and are untouched.
   *
   * The second argument is the wait between attempts — a number, or a function of the attempt
   * just finished for backoff — or the full `{ delayMs, timeoutMs }` bag. `timeoutMs` bounds
   * each attempt individually: the deadline abandons it (its signal fires, so cancellation-aware
   * work stops) and it counts as a failure like any other. A pending wait is abortable, so
   * `shutdown()` during one settles immediately rather than outliving the Task.
   *
   * ```ts
   * import { getChangedFilePathsInGitSince } from '../utils/get-changed-file-paths-in-git-since.ts';
   *
   * // Defined, not invoked: the scan spawns real git subprocesses when awaited.
   * function resilientScan(root: string, ref: string) {
   *   return getChangedFilePathsInGitSince(root, ref).retry(); // survives index.lock contention
   * }
   *
   * let attempts = 0;
   * const flakyUpload = Task(() => (++attempts < 3 ? Promise.reject(new Error('flaky')) : 'ok'));
   * await flakyUpload.retry(4); // 'ok' — succeeded on the 3rd of up to 5 fresh executions
   *
   * attempts = 0;
   * await flakyUpload.retry(4, 1); // the same, waiting 1ms between attempts
   * attempts = 0;
   * await flakyUpload.retry(4, (attempt) => attempt); // backoff: 1ms, then 2ms
   * attempts = 0;
   * await flakyUpload.retry(4, { delayMs: 1, timeoutMs: 5_000 }); // and a per-attempt deadline
   * ```
   */
  retry(times = 1, options: RetryDelay | RetryOptions = {}): TaskClass<T, E> {
    const { delayMs, timeoutMs } =
      typeof options === 'number' || typeof options === 'function'
        ? { delayMs: options, timeoutMs: undefined }
        : options;
    // An executor rather than a recipe, so the loop receives the retry Task's own AbortSignal:
    // a `shutdown()` mid-wait has to clear the pending timer, or the delay outlives the Task.
    return new TaskClass<T, E>(async (_resolve, _reject, signal) => {
      const attempts = Math.max(0, times) + 1;
      let lastReason: unknown;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const run = this.restart();
        try {
          // A per-attempt deadline is `await`'s, whose timer is already cleared on settle. It
          // does not stop the work — nothing in JS can — so the attempt is abandoned below,
          // which is what lets a cancellation-aware one actually stop.
          return await (timeoutMs === undefined ? run : run.await(timeoutMs));
        } catch (error) {
          lastReason = error;
          run.#abandon();
        }
        if (attempt < attempts) {
          const wait = typeof delayMs === 'function' ? delayMs(attempt) : (delayMs ?? 0);
          if (wait > 0) await sleep(wait, signal);
        }
      }
      throw lastReason;
    });
  }

  /**
   * Fires the abort signal of an attempt nothing will await again, so an executor that
   * subscribed to something can unsubscribe. The attempt has already settled, so this cannot
   * change any outcome — it is a cleanup notification, not a cancellation.
   *
   * Walks the derivation lineage because a chain's work lives in its source: abandoning
   * `root.map(f)` has to reach `root`, which is where the executor (and its subscription) is.
   */
  #abandon(): void {
    this.#abort(Abandoned());
  }

  /**
   * Aborts this Task and everything upstream of it.
   *
   * A derived Task holds no work of its own — `map`/`mapErr`/`context` all wrap `this.then(...)`,
   * so the executor with the live `fetch` belongs to the SOURCE. Aborting only this link fired a
   * signal nobody was listening to and left the real work running, which made cancellation a
   * no-op for every chain — and a chain is what the docs show. A combinator's members are
   * reached the same way, through the snapshot it kept for `restart`.
   */
  #abort(reason: unknown): void {
    this.#controller ??= new AbortController();
    this.#controller.abort(reason);
    if (this.#source !== undefined) this.#source.#abort(reason);
    for (const member of this.#members?.() ?? []) {
      if (member instanceof TaskClass) member.#abort(reason);
    }
  }

  // ── The one bridge to the value world ────────────────────────────────────────

  /**
   * Settles to the bare `Result<T, E>` union — the value itself, or the declared `Failure` as
   * a **value** — so a caller branches with one `Failure.is()` check and no `try`/`catch`.
   * **The two-tier gate:** only a declared `Failure` is reflected into the value world; a *bug*
   * is re-thrown, so it lands at the program's one crash boundary instead of being silently
   * returned.
   *
   * Classifying a failure also reports it to the observation seam (`Failure.observed` — the
   * `qunitx.failure.observed` channel plus `Failure.onObserved`), as do `match`/`unwrapOr`/
   * `recover`: a tracing adapter subscribed there annotates the active span with
   * `Failure.attributes(error)`, with zero tracing code at any call site.
   *
   * Lazy like every method but `ignore`, and lineage-carrying: `task.result().restart()`
   * re-runs the chain and reflects the fresh outcome.
   *
   * ```ts
   * import { isFailure, type Any as GitScanFailure } from '../result/failure.ts';
   * const scanTask = Task<Set<string>, GitScanFailure>(() => new Set(['lib/a.ts']));
   * const degradeToFullRun = (_failure: GitScanFailure) => new Set<string>();
   *
   * const scan = await scanTask.result(); // Set<string> | GitScanFailure — bare
   * if (isFailure(scan)) degradeToFullRun(scan); // scan: GitScanFailure — typed
   * else scan.has('lib/a.ts'); // scan: Set<string>
   * ```
   */
  result(): TaskClass<Result<T, E>, never> {
    return this.#derive<Result<T, E>, never>(
      () =>
        this.then<Result<T, E>, Result<T, E>>(undefined, (error: unknown) => {
          if (isFailure(error)) {
            failureObserved(error);
            return error as E & AnyFailure;
          }
          throw error;
        }),
      (fresh) => fresh.result(),
    );
  }
}

// The class is declared as `TaskClass` only because one identifier cannot be both a class
// declaration and the callable `const` below; the runtime name stays `Task` for stacks,
// `util.inspect` and devtools.
Object.defineProperty(TaskClass, 'name', { value: 'Task' });

// Snapshots a possibly one-shot iterable (generator, consumed iterator) on FIRST run, still
// inside the recipe so laziness holds — nothing is observed before the await. Without it,
// `restart()` would re-iterate an exhausted generator and silently combine over `[]`.
function snapshotOnce<T>(values: Iterable<T>): () => T[] {
  let snapshot: T[] | undefined;
  return () => (snapshot ??= Array.from(values));
}

/**
 * A member restarted, when it is something that CAN be: a Task carries its recipe, so it can
 * run again. A plain promise is already running and has no second execution to offer, so it is
 * passed through — a combinator over promises restarts the combination, not the work behind it.
 */
function restarted<Member>(member: Member): Member {
  return member instanceof TaskClass ? (member.restart() as Member) : member;
}

/** Milliseconds to wait before the next attempt, or a function of the attempt just finished —
 *  the shape `lib/job` converged on for Oban-style backoff, with a constant as its degenerate
 *  case. `(n) => Math.min(100 * 2 ** n, 30_000)` is exponential; `() => 100` is fixed. */
export type RetryDelay = number | ((attempt: number) => number);

/** The full option bag for {@link Task#retry}; pass a {@link RetryDelay} directly when the
 *  delay is all you need. */
export interface RetryOptions {
  /** Wait between attempts. Omitted or `0` retries immediately, as it always has. */
  delayMs?: RetryDelay;
  /** Deadline for each individual attempt. The attempt is abandoned when it fires — its signal
   *  goes off so cancellation-aware work stops — and counts as a failure like any other. */
  timeoutMs?: number;
}

/**
 * A delay that a signal can cut short, with nothing left behind on either path: the timer is
 * cleared when the wait is abandoned, and the listener removed when it completes. Deliberately
 * NOT unref'd — an unref'd timer lets Deno's test sanitizer (and a bare Node script) drain the
 * loop mid-wait; clearing on both exits is what keeps it honest instead.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Placeholder work for the internal construction path in `restart()`, immediately replaced. */
const EMPTY_RECIPE = (() => undefined) as unknown as Recipe<never>;

function isThenable<T>(value: unknown): value is PromiseLike<T> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as PromiseLike<T>).then === 'function'
  );
}

/**
 * The call-or-construct type of the exported {@link Task} value: the class's statics and
 * construct signature, intersected with a plain call signature.
 */
type TaskConstructor = typeof TaskClass & {
  /** Call form — `Task(source)` without `new`; identical to the constructor. */
  <T, E = AnyFailure>(source: PromiseLike<T> | Recipe<T> | Executor<T>): TaskClass<T, E>;
};

/**
 * Call-or-construct, like `Boolean`/`Date`: `Task(recipe)` and `new Task(recipe)` build the
 * same lazy Task. ES classes reject the call form, so the export is a Proxy whose `apply`
 * forwards to construction — statics, `instanceof`, and the prototype all pass through.
 *
 * ```ts
 * import { type Failure } from '../result/failure.ts';
 * type ChangeScan = { scope: 'paths'; paths: Set<string> };
 * type GitScanFailure = Failure<'GitScanFailed', { ref: string }>;
 * const runGit = async (args: string[]): Promise<ChangeScan> =>
 *   ({ scope: 'paths', paths: new Set(args) });
 *
 * const scan = Task<ChangeScan, GitScanFailure>(() => runGit(['status'])); // no `new`
 * scan instanceof Task && scan instanceof Promise; // true, true
 * ```
 */
export const Task: TaskConstructor = new Proxy(TaskClass, {
  apply(target, _thisArg, args: [recipe: () => unknown]) {
    return new target(args[0]);
  },
}) as TaskConstructor;

/**
 * The instance type of {@link Task} — value and type share the name, so a signature reads
 * `Task<Config, ConfigFailure>` while the same identifier constructs one.
 *
 * ```ts
 * const load = (id: number): Task<{ id: number }> => Task(() => ({ id }));
 * await load(7); // { id: 7 }
 * ```
 */
export type Task<T, E = AnyFailure> = TaskClass<T, E>;
