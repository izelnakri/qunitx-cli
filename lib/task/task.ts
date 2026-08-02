import { type Result } from '../result/result.ts';
import {
  Failure,
  ignore as failureIgnore,
  observed as failureObserved,
  isFailure,
  type Any as AnyFailure,
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
 * `Task<T, E>` — a **lazy, retryable** superset of `Promise<T>` for error handling that respects
 * JavaScript's rules from the ground up. `E` is the *declared* failure type: the reason a caller
 * expects when it fails, and what {@link TaskClass#result} surfaces as the `Err`. It is advisory
 * (JS rejections are untyped, so `await` still throws `unknown`) but self-documenting — a
 * `Task<Config, ConfigFailure>` reads like a `Result<Config, ConfigFailure>` signature did, and
 * `.result()` settles to the bare `Result<T, E>` union — the value itself, or the typed
 * `Failure` — which one `Failure.is()` check discriminates.
 *
 * A `Task` is a real `Promise` (`instanceof Promise` holds, and the Promises/A+ suite passes —
 * see test/task/promises-aplus.ts) built from a **recipe** — a thunk `() => T | PromiseLike<T>`
 * — that runs **only when the Task is first awaited** (or `.then`-ed, or {@link TaskClass#perform}-ed).
 * A failure is a real **rejection** whose reason is a `Failure`. Those two choices are what make
 * it work *with* the language:
 *
 *  - `await task` returns the value or throws — the JS standard, so `.then`/`.map`/`Promise.all`
 *    all see the *value*, never a wrapper. (Making `await` yield `{ ok, value, error }` would
 *    force every native method to see the wrapper too — the neverthrow trade-off, rejected. The
 *    wrapper shape lives behind one method, {@link TaskClass#result}.)
 *  - `Promise.all`/`race`/`any` fail-fast; `try`/`catch` handles it; `instanceof Promise` holds.
 *  - Because it is lazy, a relationship accessor can fire its RPC only on `await`; because every
 *    Task keeps its recipe **and its derivation lineage**, {@link TaskClass#retry}/
 *    {@link TaskClass#restart} spawn fresh executions of the *whole chain* (the
 *    ember-concurrency model — a Promise instance settles once, but the Task re-runs).
 *
 * The two-tier rule threads through every consuming method: a **declared failure** (a `Failure`)
 * is an outcome the caller planned for, a **bug** (any other rejection) is not. `result`,
 * `match`, `unwrapOr` and `expect` act only on declared failures and let bugs keep flying to the
 * one boundary that turns them into a crash report; `mapErr` (the adapter edge, where foreign
 * errors get classified *into* Failures) and `recover` (the crash boundary itself) are the two
 * deliberate catch-alls.
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
  #resolve!: (value: T | PromiseLike<T>) => void;
  #reject!: (reason: unknown) => void;
  /** Derivation lineage: the Task this one was derived from, and how to re-derive it — what
   *  makes restart/retry on a *chain* re-execute the chain's source, not just the last step. */
  #source: TaskClass<unknown, unknown> | undefined;
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
    this.#resolve = resolve;
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
      timer = setTimeout(
        () =>
          reject(
            new Failure('AwaitTimeout', `await timed out after ${timeoutMs}ms`, { ms: timeoutMs }),
          ),
        timeoutMs,
      );
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
   * recipe's AbortSignal (cancellation-aware recipes — a `fetch(url, { signal })` — stop
   * their work; JS cannot preempt others, which then finish detached), then yields for
   * `timeoutMs`: the settled `Result` if one landed, else `null` after settling the task
   * with a declared `Failure('Shutdown')` so every consumer resolves.
   *
   * ```ts
   * const task = Task((_resolve, _reject, signal) => fetch('https://example.com', { signal }));
   * task.perform();
   * const outcome = await task.shutdown(50); // Result | null — whatever had already landed
   * outcome === null || 'ok' in Object(outcome); // true
   * ```
   */
  async shutdown(timeoutMs = 5000): Promise<Result<T, E> | null> {
    this.#controller ??= new AbortController();
    const marker = new Failure('Shutdown', 'task shut down', undefined);
    if (!this.#started) {
      // Never ran: settle as shut down without ever invoking the recipe.
      this.#started = true;
      this.#reject(marker);
    } else {
      this.#controller.abort(marker);
    }
    const settled = await this.yield(timeoutMs).catch(() => null); // a bug counts as settled-nothing here
    if (settled === null) this.#reject(marker); // non-signal-aware recipe: settle consumers anyway
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
   * ```ts
   * const both = Task.all([Task(() => 'a'), Task(() => 'b')]); // nothing has started yet
   * await both; // ['a', 'b'] — both started HERE
   * ```
   */
  static override all<T extends readonly unknown[] | []>(
    values: T,
  ): TaskClass<{ -readonly [P in keyof T]: Awaited<T[P]> }>;
  static override all<T>(values: Iterable<T | PromiseLike<T>>): TaskClass<Awaited<T>[]>;
  static override all(values: Iterable<unknown>): TaskClass<unknown[]> {
    const members = snapshotOnce(values);
    const task = new TaskClass(() => Promise.all(members()));
    task.#remake = () => TaskClass.all(members().map(restarted));
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
  static override race<T extends readonly unknown[] | []>(values: T): TaskClass<Awaited<T[number]>>;
  static override race<T>(values: Iterable<T | PromiseLike<T>>): TaskClass<Awaited<T>>;
  static override race(values: Iterable<unknown>): TaskClass<unknown> {
    const members = snapshotOnce(values);
    const task = new TaskClass(() => Promise.race(members()));
    task.#remake = () => TaskClass.race(members().map(restarted));
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
   * Data-first twin of {@link TaskClass#expect} — context for declared failures only.
   *
   * ```ts
   * await Task.expect(Task(() => 'v'), 'must load'); // 'v' — context only decorates failures
   * ```
   */
  static expect<T, E>(task: TaskClass<T, E>, message: string): TaskClass<T, E> {
    return task.expect(message);
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
   * ```
   */
  static retry<T, E>(task: TaskClass<T, E>, times = 1): TaskClass<T, E> {
    return task.retry(times);
  }

  /**
   * Data-first twin of {@link TaskClass#result} — the bridge to the bare `Result` union.
   *
   * ```ts
   * const value = await Task.result(Task(() => 21 * 2)); // 42 — or the declared Failure, bare
   * ```
   */
  static result<T, E>(task: TaskClass<T, E>): TaskClass<Result<T, E>, never> {
    return task.result();
  }

  // ── Transforming — lazy, and each returns a real Task ────────────────────────
  //
  // Every method derives a fresh `Task(() => this.then(...))`: the `this.then` inside the recipe
  // triggers the upstream Task — but only when the *derived* Task is awaited, so a chain like
  // `task.map(f).expect(m)` stays fully lazy, and repeated awaits share the upstream's memoised
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
   */
  mapErr<F>(fn: (error: unknown) => F): TaskClass<T, F> {
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
   * Deliberate non-handling — the Task spelling of `promise.catch(Failure.ignore(context))`.
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
  ignore(context: string): TaskClass<T | undefined, never> {
    const report = failureIgnore(context);
    return this.#derive<T | undefined, never>(
      () =>
        this.then<T | undefined, undefined>(undefined, (error: unknown) => {
          report(error);
          return undefined;
        }),
      (fresh) => fresh.ignore(context),
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
    context: string,
  ): TaskClass<T | undefined, never> {
    return new TaskClass<T, AnyFailure>(source).ignore(context);
  }

  /**
   * Adds context to a declared failure — anyhow's `.context()`, not Rust's panicking `expect`.
   * A `Failure` rethrows as a new Failure with the **same `code` and `data`** (so `E`, and every
   * `switch` on `code`, still hold), `message` as the context line, and the original chained
   * under `cause`. A *bug* passes through untouched: promoting it into the declared tier would
   * hide it from the boundary.
   *
   * ```ts
   * const loadUser = (id: number) => Task(() => ({ name: 'u' + id }));
   *
   * await loadUser(7).expect('route /users/7 needs its user');
   * // and when loadUser rejects with Failure(NotFound), the await throws:
   * // Failure(NotFound): route /users/7 needs its user
   * //   caused by: Failure(NotFound): no user 7
   * ```
   */
  expect(message: string): TaskClass<T, E> {
    return this.#derive<T, E>(
      () =>
        this.then(undefined, (error: unknown) => {
          if (!isFailure(error)) throw error;
          throw new Failure(error.code, message, error.data, { cause: error });
        }),
      (fresh) => fresh.expect(message),
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
   * `scan.map(parse).expect(ctx).restart()` re-runs the git call, the parse, and the context
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
   * ```
   */
  retry(times = 1): TaskClass<T, E> {
    return new TaskClass<T, E>(async () => {
      const attempts = Math.max(0, times) + 1;
      let lastReason: unknown;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const run = this.restart();
        try {
          return await run;
        } catch (error) {
          lastReason = error;
          run.#abandon();
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
    this.#controller?.abort(
      new Failure('Abandoned', 'retry moved on from this attempt', undefined),
    );
    if (this.#source !== undefined) this.#source.#abandon();
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
