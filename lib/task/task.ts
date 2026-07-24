import { type Result, ok, err } from '../result/result.ts';
import { Failure, isFailure, type Any as AnyFailure } from '../result/failure.ts';

/**
 * `Task<T, E>` — a **lazy, retryable** superset of `Promise<T>` for error handling that respects
 * JavaScript's rules from the ground up. `E` is the *declared* failure type: the reason a caller
 * expects when it fails, and what {@link TaskClass#result} surfaces as the `Err`. It is advisory
 * (JS rejections are untyped, so `await` still throws `unknown`) but self-documenting — a
 * `Task<Config, ConfigFailure>` reads like a `Result<Config, ConfigFailure>` signature did, and
 * `.result()` returns a typed `Result<T, E>` so callers skip the `Failure.is` narrowing.
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
 * Construction is `Task(recipe)` or `new Task(recipe)` — the exported value is call-or-construct,
 * like `Boolean`/`Date`, because a factory reads better at the end of an adapter:
 *
 * ```ts
 * export function scanChanges(root: string): Task<ChangeScan, GitScanFailure> {
 *   return Task(() => runGit(root)).mapErr(classify).map(parse);
 * }
 * ```
 *
 * @see docs/error-handling.md
 */
class TaskClass<T, E = AnyFailure> extends Promise<T> {
  /** The recipe. Runs at most once per instance (memoised); kept so retry/restart can re-run it. */
  #recipe: () => T | PromiseLike<T>;
  #started = false;
  #resolve!: (value: T | PromiseLike<T>) => void;
  #reject!: (reason: unknown) => void;
  /** Derivation lineage: the Task this one was derived from, and how to re-derive it — what
   *  makes restart/retry on a *chain* re-execute the chain's source, not just the last step. */
  #source: TaskClass<unknown, unknown> | undefined;
  #rederive: ((fresh: TaskClass<unknown, unknown>) => TaskClass<T, E>) | undefined;

  /** The argument is a recipe, not an executor: it takes no arguments and runs on first await. */
  constructor(recipe: () => T | PromiseLike<T>) {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason: unknown) => void;
    // A no-op executor: the work does not start here (that is the whole point). We only capture
    // the resolving functions; the recipe runs later, in `#start`, on the first `.then`.
    super((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.#recipe = recipe;
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
    try {
      Promise.resolve(this.#recipe()).then(this.#resolve, this.#reject);
    } catch (error) {
      // A synchronous throw from the recipe becomes the rejection, same as an async one.
      this.#reject(error);
    }
  }

  /**
   * Runs the recipe on first await/then. This is the single trigger point for the lazy work —
   * `catch` and `finally` route through it too, since both call `then` per spec.
   *
   * The signature mirrors `Promise.prototype.then` exactly (including `reason: any`, which the
   * lib.d.ts declaration uses) so the subclass stays assignable everywhere a Promise is.
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
   */
  perform(): this {
    this.#start();
    return this;
  }

  // ── Builders ─────────────────────────────────────────────────────────────────

  /** Lifts a promise or a recipe into a Task. A recipe stays lazy; a passed promise is already
   *  running (JS starts promises at creation) — the Task then only defers *observation*. */
  static from<T, E = AnyFailure>(
    source: PromiseLike<T> | (() => T | PromiseLike<T>),
  ): TaskClass<T, E> {
    return new TaskClass(typeof source === 'function' ? source : () => source);
  }

  /**
   * The call boundary with arguments — `Promise.try`'s shape, made lazy: `fn(...args)` runs on
   * first await, and whatever it throws (sync or async) becomes the rejection. The closure the
   * caller would otherwise write by hand (`Task(() => fn(a, b))`) is built here instead.
   */
  static override try<T, A extends unknown[]>(
    fn: (...args: A) => T | PromiseLike<T>,
    ...args: A
  ): TaskClass<Awaited<T>> {
    return new TaskClass(() => fn(...args)) as TaskClass<Awaited<T>>;
  }

  /**
   * A resolved Task. Overridden because the inherited `Promise.resolve` builds via
   * `new this(executor)`, which our recipe constructor would misread. Same for every static
   * below that the base class would otherwise construct through `NewPromiseCapability`.
   */
  static override resolve(): TaskClass<void>;
  static override resolve<T>(value: T | PromiseLike<T>): TaskClass<Awaited<T>>;
  static override resolve<T>(value?: T | PromiseLike<T>): TaskClass<Awaited<T>> {
    return new TaskClass(() => value as Awaited<T>);
  }

  /** A rejected Task, spec-shaped (`reason` erased to `unknown`). Prefer {@link TaskClass.fail},
   *  which keeps the reason's type as the Task's declared `E`. */
  static override reject<T = never>(reason?: unknown): TaskClass<T> {
    return new TaskClass<T>(() => Promise.reject(reason));
  }

  /** A Task that fails with `reason` (a rejection — so `await` throws it), typed: the declared
   *  `E` is exactly `reason`'s type. */
  static fail<F>(reason: F): TaskClass<never, F> {
    return new TaskClass<never, F>(() => Promise.reject(reason));
  }

  /** `Promise.withResolvers`, returning a Task settled from outside. Lazy like everything else:
   *  the Task only *observes* the external settlement once something awaits it. */
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

  static override all<T extends readonly unknown[] | []>(
    values: T,
  ): TaskClass<{ -readonly [P in keyof T]: Awaited<T[P]> }>;
  static override all<T>(values: Iterable<T | PromiseLike<T>>): TaskClass<Awaited<T>[]>;
  static override all(values: Iterable<unknown>): TaskClass<unknown[]> {
    return new TaskClass(() => Promise.all(values));
  }

  static override race<T extends readonly unknown[] | []>(values: T): TaskClass<Awaited<T[number]>>;
  static override race<T>(values: Iterable<T | PromiseLike<T>>): TaskClass<Awaited<T>>;
  static override race(values: Iterable<unknown>): TaskClass<unknown> {
    return new TaskClass(() => Promise.race(values));
  }

  static override any<T extends readonly unknown[] | []>(values: T): TaskClass<Awaited<T[number]>>;
  static override any<T>(values: Iterable<T | PromiseLike<T>>): TaskClass<Awaited<T>>;
  static override any(values: Iterable<unknown>): TaskClass<unknown> {
    return new TaskClass(() => Promise.any(values));
  }

  static override allSettled<T extends readonly unknown[] | []>(
    values: T,
  ): TaskClass<{ -readonly [P in keyof T]: PromiseSettledResult<Awaited<T[P]>> }>;
  static override allSettled<T>(
    values: Iterable<T | PromiseLike<T>>,
  ): TaskClass<PromiseSettledResult<Awaited<T>>[]>;
  static override allSettled(
    values: Iterable<unknown>,
  ): TaskClass<PromiseSettledResult<unknown>[]> {
    return new TaskClass(() => Promise.allSettled(values));
  }

  /**
   * Awaits every task and returns their outcomes **positionally** — index-preserving, so a batch
   * knows *which* input failed, and no success is discarded (unlike `Promise.all`'s fail-fast).
   * The errors are the declared `E`; a *bug* in any task rejects the whole call, matching
   * {@link TaskClass#result}'s two-tier rule. (Named `results`, not `allSettled`, which is the
   * inherited static with the spec's `{ status, … }` shape.)
   */
  static results<T, E = AnyFailure>(
    tasks: Iterable<TaskClass<T, E> | PromiseLike<T>>,
  ): TaskClass<Result<T, E>[], never> {
    return new TaskClass(() =>
      Promise.all(Array.from(tasks, (task) => TaskClass.from<T, E>(task).result())),
    );
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

  /** Transforms the success value — `.then(fn)` that stays a Task: lazy, retryable, `E` kept.
   *  `fn` may return a value or a promise of one (they flatten), so this is `andThen` too. */
  map<U>(fn: (value: T) => U | PromiseLike<U>): TaskClass<U, E> {
    return this.#derive(
      () => this.then(fn),
      (fresh) => fresh.map(fn),
    );
  }

  /**
   * Transforms the failure reason — **the adapter edge**. This is the one transforming method
   * that sees *every* rejection (`error: unknown`), because its job is to classify foreign
   * errors — an `execFile` timeout, a driver throw — *into* the declared `Failure` taxonomy.
   * Downstream of a `mapErr`, the two-tier methods can trust what they see.
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
   */
  recover<U = T>(fn: (error: unknown) => U | PromiseLike<U>): TaskClass<T | U, never> {
    return this.#derive<T | U, never>(
      () => this.then<T | U, T | U>(undefined, fn),
      (fresh) => fresh.recover(fn),
    );
  }

  /**
   * Adds context to a declared failure — anyhow's `.context()`, not Rust's panicking `expect`.
   * A `Failure` rethrows as a new Failure with the **same `code` and `data`** (so `E`, and every
   * `switch` on `code`, still hold), `message` as the context line, and the original chained
   * under `cause`. A *bug* passes through untouched: promoting it into the declared tier would
   * hide it from the boundary.
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

  /** Substitutes `fallback` for a **declared** failure. A bug still rejects — a fallback that
   *  absorbed a `TypeError` would be the silent-bug-hider the two-tier rule exists to prevent. */
  unwrapOr<U>(fallback: U): TaskClass<T | U, never> {
    return this.#derive<T | U, never>(
      () =>
        this.then<T | U, T | U>(undefined, (error: unknown) => {
          if (!isFailure(error)) throw error;
          return fallback;
        }),
      (fresh) => fresh.unwrapOr(fallback),
    );
  }

  /** Handles both declared branches — `err` receives the typed `E`, so it is two-tier like
   *  {@link TaskClass#result}: a bug belongs to neither branch and keeps rejecting. */
  match<A, B>(handlers: {
    ok: (value: T) => A | PromiseLike<A>;
    err: (error: E) => B | PromiseLike<B>;
  }): TaskClass<A | B, never> {
    return this.#derive<A | B, never>(
      () =>
        this.then<A | B, A | B>(handlers.ok, (error: unknown) => {
          if (!isFailure(error)) throw error;
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
   */
  restart(): TaskClass<T, E> {
    if (this.#source !== undefined && this.#rederive !== undefined) {
      return this.#rederive(this.#source.restart());
    }
    return new TaskClass<T, E>(this.#recipe);
  }

  /**
   * Re-runs until success, spawning a fresh {@link TaskClass#restart} execution per attempt —
   * the first attempt included, so a Task that already ran and failed retries cleanly. Gives up
   * after `times` retries (initial + `times` executions) and rejects with the last reason.
   * Failure-blind by design: transient bugs (a socket reset surfacing as a raw error before its
   * `mapErr`) are exactly what call sites retry, so every rejection counts as an attempt.
   */
  retry(times = 1): TaskClass<T, E> {
    return new TaskClass<T, E>(async () => {
      const attempts = Math.max(0, times) + 1;
      let lastReason: unknown;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          return await this.restart();
        } catch (error) {
          lastReason = error;
        }
      }
      throw lastReason;
    });
  }

  // ── The one bridge to the value world ────────────────────────────────────────

  /**
   * Reflects the outcome to a plain `{ ok, value, error }` that never rejects for a declared
   * failure — the source of the `const { ok, value, error } = await task.result()` ergonomics,
   * and the way to drop `try`/`catch` where a caller branches on failure inline. **The two-tier
   * gate:** a declared `Failure` becomes a typed `Err<E>`; a *bug* is re-thrown, so it lands at
   * the program's one crash boundary instead of being silently boxed.
   *
   * Lazy like everything else, and lineage-carrying: `task.result().restart()` re-runs the
   * chain and reflects the fresh outcome.
   */
  result(): TaskClass<Result<T, E>, never> {
    return this.#derive<Result<T, E>, never>(
      () =>
        this.then(
          (value): Result<T, E> => ok(value),
          (error: unknown): Result<T, E> => {
            if (isFailure(error)) return err(error as E & AnyFailure);
            throw error;
          },
        ),
      (fresh) => fresh.result(),
    );
  }
}

// The class is declared as `TaskClass` only because one identifier cannot be both a class
// declaration and the callable `const` below; the runtime name stays `Task` for stacks,
// `util.inspect` and devtools.
Object.defineProperty(TaskClass, 'name', { value: 'Task' });

type TaskConstructor = typeof TaskClass & {
  /** Call form — `Task(recipe)` without `new`; identical to `new Task(recipe)`. */
  <T, E = AnyFailure>(recipe: () => T | PromiseLike<T>): TaskClass<T, E>;
};

/**
 * Call-or-construct, like `Boolean`/`Date`: `Task(recipe)` and `new Task(recipe)` build the
 * same lazy Task. ES classes reject the call form, so the export is a Proxy whose `apply`
 * forwards to construction — statics, `instanceof`, and the prototype all pass through.
 */
export const Task: TaskConstructor = new Proxy(TaskClass, {
  apply(target, _thisArg, args: [recipe: () => unknown]) {
    return new target(args[0]);
  },
}) as TaskConstructor;

/** The instance type of {@link Task} — value and type share the name, so a signature reads
 *  `Task<Config, ConfigFailure>` while the same identifier constructs one. */
export type Task<T, E = AnyFailure> = TaskClass<T, E>;
