import { type Result, ok, err } from '../result/result.ts';
import { isFailure, type Any as AnyFailure } from '../result/failure.ts';

/**
 * `Task<T, E>` — a **lazy, retryable** superset of `Promise<T>` for error handling that respects
 * JavaScript's rules from the ground up. `E` is the *declared* failure type: the reason a caller
 * expects when it fails, and what {@link Task#result} surfaces as the `Err`. It is advisory (JS
 * rejections are untyped, so `await` still throws `unknown`) but self-documenting — a
 * `Task<Config, ConfigFailure>` reads like the old `Result<Config, ConfigFailure>` did, and
 * `.result()` returns a typed `Result<T, E>` so callers skip the `Failure.is` narrowing.
 *
 * A `Task` is a real `Promise` (`instanceof Promise` is true) built from a **recipe** — a thunk
 * `() => T | PromiseLike<T>` — that runs **only when the Task is first awaited** (or `.then`-ed).
 * A failure is a real **rejection** whose reason is a `Failure`. Those two choices are what make it
 * work *with* the language:
 *
 *  - `await task` returns the value or throws — the JS standard, so `.then`/`.map`/`Promise.all`
 *    all see the *value*, never a wrapper. (Making `await` yield `{ ok, value, error }` would force
 *    every native method to see the wrapper too — a Promise whose `.then` isn't the value is the
 *    biggest WTF there is. So the shape lives behind one method, {@link Task#result}.)
 *  - `Promise.all`/`race`/`any` fail-fast; `try`/`catch` handles it; `instanceof Promise` holds.
 *  - Because it is lazy, a relationship accessor can fire its RPC only on `await`; because it keeps
 *    its recipe, {@link Task#retry}/{@link Task#restart} spawn fresh executions (the
 *    `ember-concurrency` model — a Promise instance settles once, but the Task re-runs the recipe).
 *
 * Most of the "Result combinator" surface is just methods `Promise` already has — `.map`/`.andThen`
 * are `then`, `.mapErr`/`.recover` are `catch` — so the only genuinely new operation is
 * {@link Task#result}, the bridge to a plain `{ ok, value, error }` that never rejects (a declared
 * `Failure` becomes an `Err`; a *bug* is re-thrown, keeping the two-tier line).
 *
 * @see docs/error-handling.md
 */
export class Task<T, E = AnyFailure> extends Promise<T> {
  /** The recipe. Runs at most once per instance (memoised); kept so `retry`/`restart` can re-run it. */
  #recipe: (() => T | PromiseLike<T>) | undefined;
  #started = false;
  #resolve!: (value: T | PromiseLike<T>) => void;
  #reject!: (reason: unknown) => void;

  /** Prefer the static builders (`Task.of`/`from`/`run`/`try`). The argument is a recipe, not an executor. */
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
    const recipe = this.#recipe;
    if (!recipe) return;
    try {
      Promise.resolve(recipe()).then(this.#resolve, this.#reject);
    } catch (error) {
      // A synchronous throw from the recipe becomes the rejection, same as an async one.
      this.#reject(error);
    }
  }

  /**
   * Runs the recipe on first await/then. This is the single trigger point for the lazy work.
   *
   * The signature mirrors `Promise.prototype.then` exactly (including `reason: any`, which the
   * lib.d.ts declaration uses) so the subclass's static side stays assignable to `PromiseConstructor`.
   */
  override then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    // deno-lint-ignore no-explicit-any
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    this.#start();
    return super.then(onfulfilled, onrejected);
  }

  // ── Builders ─────────────────────────────────────────────────────────────────

  /** A Task from a recipe, a value, or a promise. A recipe/promise stays lazy until awaited. */
  static of<T>(source: T | PromiseLike<T> | (() => T | PromiseLike<T>)): Task<T> {
    return new Task(
      typeof source === 'function' ? (source as () => T | PromiseLike<T>) : () => source,
    );
  }

  /** A Task that fails with `reason` (a rejection — so `await` throws it). Carries `reason`'s type. */
  static fail<F>(reason: F): Task<never, F> {
    return new Task<never, F>(() => Promise.reject(reason));
  }

  /** Lifts a promise or a recipe into a Task. Identical to {@link Task.of}; named for intent. */
  static from<T>(source: PromiseLike<T> | (() => T | PromiseLike<T>)): Task<T> {
    return Task.of(source);
  }

  /** Runs `fn` as a Task: its return succeeds, and any throw — sync or async — becomes the failure. */
  static run<T>(fn: () => T | PromiseLike<T>): Task<T> {
    return new Task(fn);
  }

  /**
   * The boundary for throwing third-party code: runs `fn` and turns whatever it throws into a
   * rejection. Same mechanism as {@link Task.run}; the name marks the intent of wrapping a
   * function that throws rather than one that already rejects with a `Failure`.
   */
  static override try<T, U extends unknown[]>(
    fn: (...args: U) => T | PromiseLike<T>,
    ...args: U
  ): Task<Awaited<T>> {
    return new Task(() => fn(...args)) as Task<Awaited<T>>;
  }

  /**
   * A resolved Task. Overridden because the inherited `Promise.resolve` builds via
   * `new this(executor)`, which our recipe constructor would misread — the override (and the
   * inherited `all`/`race`/`any`, which call `this.resolve` internally) construct correct Tasks.
   */
  static override resolve(): Task<void>;
  /** A Task resolved with `value`. */
  static override resolve<T>(value: T | PromiseLike<T>): Task<Awaited<T>>;
  static override resolve<T>(value?: T | PromiseLike<T>): Task<Awaited<T>> {
    return new Task(() => value as Awaited<T>);
  }

  /** A rejected Task. Overridden for the same reason as {@link Task.resolve}. */
  static override reject<T = never>(reason?: unknown): Task<T> {
    return new Task<T>(() => Promise.reject(reason));
  }

  // ── Transforming — lazy, and each returns a real Task ────────────────────────
  //
  // Every method wraps the continuation in a fresh `Task(() => this.then(...))`. The `this.then`
  // inside the recipe is what triggers the upstream Task — but only when the *returned* Task is
  // awaited, so a chain like `task.map(f).andThen(g)` stays fully lazy.

  /** Transforms the success value, passing a failure through untouched. Keeps the declared `E`. */
  map<U>(fn: (value: T) => U | PromiseLike<U>): Task<U, E> {
    return new Task(() => this.then(fn));
  }

  /** Chains a second fallible step onto success, short-circuiting on failure. Keeps the declared `E`. */
  andThen<U>(fn: (value: T) => PromiseLike<U>): Task<U, E> {
    return new Task(() => this.then(fn));
  }

  /** Transforms the failure reason — and re-declares the failure type as `F`, what `fn` returns. */
  mapErr<F>(fn: (error: unknown) => F): Task<T, F> {
    return new Task<T, F>(() =>
      this.then(undefined, (error) => {
        throw fn(error);
      }),
    );
  }

  /** Recovers from a failure by producing a success value (Rust's `unwrap_or_else`) — so `E` is gone. */
  recover(fn: (error: unknown) => T | PromiseLike<T>): Task<T, never> {
    return new Task(() => this.then(undefined, fn));
  }

  /** Like `await task`, but a failure rethrows as `new Error(message, { cause })` — a bug, so no `E`. */
  expect(message: string): Task<T, never> {
    return new Task(() =>
      this.then(undefined, (error) => {
        throw new Error(message, { cause: error });
      }),
    );
  }

  /** Resolves to the success value, or `fallback` if the Task failed — so the failure is handled. */
  unwrapOr<U>(fallback: U): Task<T | U, never> {
    return new Task<T | U, never>(() => this.then(undefined, () => fallback));
  }

  /** Exhaustively handles both branches — both settled, so nothing is left to fail. */
  match<A, B>(handlers: { ok: (value: T) => A; err: (error: unknown) => B }): Task<A | B, never> {
    return new Task<A | B, never>(() => this.then(handlers.ok, handlers.err));
  }

  // ── Retry / restart — fresh executions from the kept recipe ───────────────────

  /** A Task that runs the recipe again on each failure, up to `times` extra attempts. */
  retry(times: number): Task<T, E> {
    const recipe = this.#recipe;
    if (!recipe) throw new Error('Task.retry: this Task has no recipe to re-run');
    return new Task<T, E>(async () => {
      let last: unknown;
      for (let attempt = 0; attempt <= times; attempt++) {
        try {
          return await recipe();
        } catch (error) {
          last = error;
        }
      }
      throw last;
    });
  }

  /** A fresh Task from the same recipe — a new execution, independent of this one. */
  restart(): Task<T, E> {
    const recipe = this.#recipe;
    if (!recipe) throw new Error('Task.restart: this Task has no recipe to re-run');
    return new Task<T, E>(recipe);
  }

  // ── The one bridge to the value world ────────────────────────────────────────

  /**
   * Reflects the outcome to a plain `{ ok, value, error }` that never rejects — the source of the
   * `const { ok, value, error } = await task.result()` ergonomics, and the way to drop `try`/`catch`
   * where you want to branch on failure inline. A declared `Failure` becomes an `Err`; a *bug* (a
   * non-Failure rejection) is re-thrown, so bugs keep behaving like bugs.
   *
   * Lazy, like everything else: nothing runs until the returned Task is awaited. The `Err` is
   * typed as the Task's declared `E`, so a `Task<T, GitScanFailed>` gives `Result<T, GitScanFailed>`
   * — the caller reads `scan.error.data` directly, without a `Failure.is` narrowing step.
   */
  result(): Task<Result<T, E>, never> {
    return new Task(() =>
      this.then(
        (value): Result<T, E> => ok(value),
        (error): Result<T, E> => {
          if (isFailure(error)) return err(error as E & AnyFailure);
          throw error;
        },
      ),
    );
  }

  /** Alias of {@link Task#result} — Bluebird's name for this reflection. */
  reflect(): Task<Result<T, E>, never> {
    return this.result();
  }

  /** Static `result`: lift `source` and reflect it in one step. */
  static result<T>(source: PromiseLike<T>): Task<Result<T, AnyFailure>> {
    return Task.of(source).result();
  }

  /**
   * Awaits every task and returns their outcomes **positionally** — index-preserving, so a batch
   * knows *which* input failed, and no success is discarded (unlike `Promise.all`'s fail-fast). A
   * *bug* in any task rejects the whole call, matching `result`'s two-tier rule. (Named `results`,
   * not `allSettled`, which is an inherited static with a different shape.)
   */
  static results<T>(tasks: Iterable<PromiseLike<T>>): Task<Result<T, AnyFailure>[]> {
    return Task.of(() => Promise.all(Array.from(tasks, (task) => Task.of(task).result())));
  }
}
