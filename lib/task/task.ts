import { type Result, ok, err } from '../result/result.ts';
import { Failure, isFailure, type Any as AnyFailure } from '../result/failure.ts';

/**
 * `Task<T>` — a superset of `Promise<T>` for error handling that works *with* the language,
 * not against it.
 *
 * A `Task` is a real `Promise` (`instanceof Promise` is true), with one convention: a failure is
 * a **rejection** whose reason is a {@link Failure}. That single choice is what lets everything
 * native keep working — `await` returns the value or throws, `try`/`catch` handles it,
 * `Promise.all`/`race`/`any` fail-fast, and `instanceof Promise` holds — while a rich, typed,
 * serializable `Failure` describes *what* went wrong.
 *
 * Because failure is a rejection, most of the "Result combinator" surface collapses into methods
 * `Promise` already has:
 *
 *  - `.map` / `.andThen`  →  `.then`   (JS's `.then` auto-flattens, so it is both)
 *  - `.mapErr` / `.recover`  →  `.catch`
 *  - unwrap / expect  →  `await task`  (it throws on failure; `.expect(msg)` customises the message)
 *  - `.match`  →  `.then(onOk, onErr)`
 *
 * So `Task` adds almost nothing to learn. The one genuinely new operation is {@link Task#settle},
 * the deliberate bridge from the rejection world to a plain `{ ok, value, error }` value — for the
 * two things native rejection is bad at: inspecting an outcome without a `try`/`catch`, and
 * collecting a batch without losing the successes.
 *
 * The one rule: `const { ok, value, error }` comes from `.settle()`, never from `await task`.
 * Making `await task` yield the value shape would be failure-as-value again, and would kill the
 * `Promise.all` fail-fast you get for free here.
 *
 * @see docs/error-handling.md
 */
export class Task<T> extends Promise<T> {
  // ── Builders ───────────────────────────────────────────────────────────────

  /** A Task already succeeded with `value`. (Native `resolve`, typed as a Task.) */
  static of<T>(value: T | PromiseLike<T>): Task<T> {
    return Task.resolve(value) as Task<T>;
  }

  /** A Task already failed with `failure` — a real rejection, so `await` throws it. */
  static fail(failure: Failure): Task<never> {
    return Task.reject(failure) as Task<never>;
  }

  /**
   * Lifts a promise, a value, or a thunk into a Task. A thunk is preferred: it runs the
   * synchronous part inside the Task too, so a synchronous throw becomes a rejection rather than
   * escaping past the boundary.
   */
  static from<T>(source: PromiseLike<T> | T | (() => T | PromiseLike<T>)): Task<T> {
    return typeof source === 'function'
      ? Task.run(source as () => T | PromiseLike<T>)
      : (Task.resolve(source) as Task<T>);
  }

  /** Runs `fn` as a Task: its return value succeeds, anything it throws becomes the rejection. */
  static run<T>(fn: () => T | PromiseLike<T>): Task<T> {
    return (Task.resolve() as Task<void>).then(fn) as Task<T>;
  }

  // ── Transforming (thin over native, typed to return Task) ────────────────────

  /** Transforms the success value, passing a failure through untouched. (= `then`.) */
  map<U>(fn: (value: T) => U | PromiseLike<U>): Task<U> {
    return this.then(fn) as unknown as Task<U>;
  }

  /** Chains a second fallible step onto success, short-circuiting on failure. (= `then`.) */
  andThen<U>(fn: (value: T) => PromiseLike<U>): Task<U> {
    return this.then(fn) as unknown as Task<U>;
  }

  /** Transforms the failure reason, passing a success through untouched. */
  mapErr(fn: (error: unknown) => unknown): Task<T> {
    return this.catch((error) => {
      throw fn(error);
    }) as unknown as Task<T>;
  }

  /** Recovers from a failure by producing a success value. (Rust's `unwrap_or_else`.) */
  recover(fn: (error: unknown) => T | PromiseLike<T>): Task<T> {
    return this.catch(fn) as unknown as Task<T>;
  }

  /** Like `await task`, but a failure rethrows as `new Error(message, { cause })`. */
  expect(message: string): Task<T> {
    return this.catch((error) => {
      throw new Error(message, { cause: error });
    }) as unknown as Task<T>;
  }

  /** Resolves to the success value, or `fallback` if the Task failed. */
  unwrapOr<U>(fallback: U): Task<T | U> {
    return this.catch(() => fallback) as unknown as Task<T | U>;
  }

  /** Exhaustively handles both branches. (= `then(onOk, onErr)`.) */
  match<A, B>(handlers: { ok: (value: T) => A; err: (error: unknown) => B }): Task<A | B> {
    return this.then(handlers.ok, handlers.err) as unknown as Task<A | B>;
  }

  // ── The one bridge to the value world ────────────────────────────────────────

  /**
   * Reflects the outcome to a plain `{ ok, value, error }` that never rejects — the source of the
   * `const { ok, value, error }` ergonomics. A declared {@link Failure} becomes an `Err`; anything
   * else (a bug — a `TypeError`, a thrown string) is **re-thrown**, so bugs keep behaving like bugs.
   */
  settle(): Promise<Result<T, AnyFailure>> {
    return this.then(
      (value): Result<T, AnyFailure> => ok(value),
      (error): Result<T, AnyFailure> => {
        if (isFailure(error)) return err(error);
        throw error;
      },
    );
  }

  /** Static `settle`: lift `source` and reflect it in one step. */
  static settle<T>(source: PromiseLike<T>): Promise<Result<T, AnyFailure>> {
    return Task.from(source).settle();
  }

  /**
   * Awaits every task and returns their outcomes **positionally** — index-preserving, so a batch
   * writer knows *which* input failed. No success is ever discarded (unlike `Promise.all`'s
   * fail-fast). A bug in any task rejects the whole call, matching `settle`'s two-tier rule.
   *
   * Named `settleAll`, not `allSettled`, because `Promise.allSettled` is an inherited static with
   * a different return shape and cannot be re-typed.
   */
  static settleAll<T>(tasks: Iterable<PromiseLike<T>>): Promise<Result<T, AnyFailure>[]> {
    return Promise.all(Array.from(tasks, (task) => Task.from(task).settle()));
  }
}
