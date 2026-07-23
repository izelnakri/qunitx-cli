/**
 * `AsyncResult<T, E>` — the awaitable producer half, for the ergonomics a plain `Result`
 * deliberately gives up.
 *
 * A `Result` is inert plain data on purpose: it has no `.then`, so it survives `structuredClone`,
 * `postMessage`, a WebSocket hop and `JSON.parse` unchanged, and so the async machinery never
 * silently assimilates it. Those same properties make it read inside-out — `andThen(map(r, f), g)`
 * — and give it no `await`-able form.
 *
 * `AsyncResult` puts the `.then` back, in the one place it is safe: on the *producer*, not on the
 * settled value. It is a thenable that **resolves to a plain `Result`**. Because a `Result` is
 * non-thenable, the Promise resolution algorithm's recursive assimilation terminates at it — so
 * `await someAsyncResult` hands you a plain `Result<T, E>`, exactly the object you branch on:
 *
 * ```ts
 * const r = await Config.setup();     // r: Result<Config, ConfigFailure> — a plain object
 * if (!r.ok) return handle(r.error);
 * use(r.value);
 * ```
 *
 * and the chain reads left-to-right, still settling to a plain `Result`:
 *
 * ```ts
 * const r = await Config.setup().map(normalise).andThen(validate);
 * ```
 *
 * The invariant that makes this sound, and that must never be broken: **the value you get after
 * awaiting is plain; only the thing you put `await` in front of is thenable.** Make the *value*
 * thenable instead and every `Promise<Result<T,E>>` collapses to `Promise<T>` at the first await
 * — see the "await is a lie to the reader" discussion in `docs/error-handling.md`.
 *
 * `AsyncResult` never *rejects* for a declared failure — an `Err` is a resolved value. That is
 * what keeps `Promise.all([...asyncResults])` from fail-fasting: it collects every settled
 * `Result`, successes and failures alike, ready for `partition`.
 */

import { type Result, type Ok, type Err, ok, err } from './result.ts';

/** A value that can be lifted into the async chain: a plain `Result` or another `AsyncResult`. */
type Awaitable<T, E> = Result<T, E> | AsyncResult<T, E> | PromiseLike<Result<T, E>>;

/**
 * An awaitable, chainable producer of a `Result<T, E>`. Thenable — but resolves to a **plain**
 * `Result`, so `await` never assimilates past it. Construct with `asyncResult()` or the statics.
 */
export class AsyncResult<T, E> implements PromiseLike<Result<T, E>> {
  /** The underlying promise of a *plain* Result. Private so the plain-value invariant holds. */
  readonly #promise: Promise<Result<T, E>>;

  /** Wrap a `Promise<Result<T, E>>`. Prefer the `asyncResult()` helper or the statics below. */
  constructor(promise: Promise<Result<T, E>>) {
    this.#promise = promise;
  }

  /**
   * The thenable contract. Resolves to a **plain** `Result<T, E>` — never to another thenable,
   * so `Awaited<AsyncResult<T, E>>` is `Result<T, E>` and `await` never assimilates past it.
   */
  then<A = Result<T, E>, B = never>(
    onfulfilled?: ((value: Result<T, E>) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.#promise.then(onfulfilled, onrejected);
  }

  /** Applies `fn` to a success value, passing failures through untouched. */
  map<U>(fn: (value: T) => U): AsyncResult<U, E> {
    return new AsyncResult(this.#promise.then((r) => (r.ok ? ok(fn(r.value)) : (r as Err<E>))));
  }

  /** Applies `fn` to a failure, passing successes through untouched. */
  mapErr<F>(fn: (error: E) => F): AsyncResult<T, F> {
    return new AsyncResult(this.#promise.then((r) => (r.ok ? (r as Ok<T>) : err(fn(r.error)))));
  }

  /**
   * Chains a second fallible async step onto a success, short-circuiting on failure. `fn` may
   * return a plain `Result`, another `AsyncResult`, or a `Promise<Result>` — all are flattened,
   * so chains never nest.
   */
  andThen<U, F>(fn: (value: T) => Awaitable<U, F>): AsyncResult<U, E | F> {
    // `Promise.resolve` assimilates all three `Awaitable` forms — a plain Result, an
    // AsyncResult (thenable resolving to a Result), or a Promise<Result> — down to one
    // `Promise<Result>`, so a chained step never nests.
    const chained: Promise<Result<U, E | F>> = this.#promise.then((r) =>
      r.ok ? (Promise.resolve(fn(r.value)) as Promise<Result<U, E | F>>) : (r as Err<E | F>),
    );
    return new AsyncResult(chained);
  }

  /** Exhaustively handles both branches once the Result settles. */
  match<A, B>(handlers: { ok: (value: T) => A; err: (error: E) => B }): Promise<A | B> {
    return this.#promise.then((r) => (r.ok ? handlers.ok(r.value) : handlers.err(r.error)));
  }

  /** Resolves to the success value, or `fallback` if it failed. */
  unwrapOr<U>(fallback: U): Promise<T | U> {
    return this.#promise.then((r) => (r.ok ? r.value : fallback));
  }

  /** A resolved `AsyncResult` carrying a success. */
  static ok<T>(value: T): AsyncResult<T, never> {
    return new AsyncResult<T, never>(Promise.resolve(ok(value)));
  }

  /** A resolved `AsyncResult` carrying a failure. */
  static err<E>(error: E): AsyncResult<never, E> {
    return new AsyncResult<never, E>(Promise.resolve(err(error)));
  }
}

/**
 * Lifts a `Promise<Result<T, E>>` into an `AsyncResult<T, E>` — exported as `Result.from`, the
 * ergonomic wrapper around an async function that already returns a `Result`.
 *
 * ```ts
 * export function setup(): AsyncResult<Config, ConfigFailure> {
 *   return Result.from(assemble());   // assemble(): Promise<Result<Config, ConfigFailure>>
 * }
 * ```
 *
 * A caller that only `await`s gets a plain `Result` and never needs to know `AsyncResult` exists;
 * a caller that wants to chain reaches for `.map` / `.andThen`. Both read the same at the call.
 *
 * **Why `from` is *only* a lift, and not the `Array.from`-style universal converter it could
 * look like.** Two overloads that would seem natural are deliberately absent, because each
 * collides with something that already has a home:
 *
 *  - **`from(rawPromise: Promise<T>)` — a throw boundary.** A promise that can *reject* needs a
 *    declared `catch`, or it silently catches everything and a bug becomes a tidy `Err` (the
 *    defect the whole design rejects). That declaration has no natural slot in a one-argument
 *    `from(x)`, and adding it just reinvents `Result.try(promise, { catch })`. So `from` accepts
 *    only a `Promise<Result>` — a promise that *already* yields a Result and, by convention,
 *    only rejects on a bug. It is a lift, never a boundary; the boundary is `Result.try`.
 *  - **`from(fn) → wrappedFn` — a function decorator.** `Result.try(fn)` already takes a
 *    function, and it *executes* it. A `from(fn)` that instead *wrapped* it (returning a new
 *    Result-returning function) would give the same `function` argument two incompatible
 *    meanings — "run this now" vs "hand me back a wrapped version" — which no reader could tell
 *    apart at the call site. `neverthrow` keeps these as two names (`fromPromise` vs
 *    `fromThrowable`) for exactly this reason; folding them into one `from` is the collision.
 *
 * The result is that `Result.from` normalises *into* the async-Result world (a lift) while
 * `Result.try` is the one boundary *into* the Result world from throwing code — two verbs, two
 * jobs, no overlap. That is the opposite of `Array.from`'s many-shapes-to-one-Array role, and
 * the difference is the point.
 */
export function asyncResult<T, E>(promise: Promise<Result<T, E>>): AsyncResult<T, E> {
  return new AsyncResult(promise);
}
