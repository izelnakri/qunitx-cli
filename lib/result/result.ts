/**
 * `Result<T, E>` — a value that is either a success or a declared failure.
 *
 * This is the *value* half of the error system; `attempt.ts` is the *boundary* half and
 * `failure.ts` is the *taxonomy* half. The split mirrors Lua, where `error()`/`pcall()`
 * (boundary) and the `nil, err` return convention (value) are deliberately different
 * mechanisms used for different classes of problem — see `docs/error-handling.md`.
 *
 * Design constraints, in priority order:
 *
 *  1. **Plain data.** A Result is an object literal — no class, no prototype, no methods.
 *     It survives `structuredClone`, `postMessage`, `JSON.stringify` and a WebSocket hop
 *     unchanged. Every class-based Result library (neverthrow, true-myth, Effect) arrives
 *     at the other side of such a boundary as a shapeless object with its methods gone.
 *  2. **Narrowing that always works.** A discriminated union on a boolean literal narrows
 *     under `if`, under destructuring, and in `switch` — with no `as`, no assertion
 *     function, and no dependence on how the value was produced.
 *  3. **One hidden class.** `ok()` and `err()` emit the same three keys in the same order,
 *     so `result.ok` stays a monomorphic load site instead of degrading to polymorphic the
 *     first time both variants flow through the same code. See the perf notes below.
 *
 * The `readonly` markers are compile-time only; nothing is frozen at runtime (freezing every
 * Result would cost more than it protects, and the type already forbids assignment).
 */

// ── The type ─────────────────────────────────────────────────────────────────

/** A successful Result carrying `value`. `error` is present-but-undefined to keep the shape stable. */
export type Ok<T> = {
  readonly ok: true;
  readonly value: T;
  readonly error?: undefined;
};

/** A failed Result carrying `error`. `value` is present-but-undefined to keep the shape stable. */
export type Err<E> = {
  readonly ok: false;
  readonly value?: undefined;
  readonly error: E;
};

/**
 * Either an `Ok<T>` or an `Err<E>`.
 *
 * `E` defaults to `unknown` rather than `Error` on purpose: an un-narrowed error is exactly
 * as untrustworthy as a `catch` binding, and typing it `unknown` makes the type checker say
 * so at the use site instead of letting a wrong assumption compile.
 */
export type Result<T, E = unknown> = Ok<T> | Err<E>;

/** Extracts the success type of a Result (`Success<Result<User, IoError>>` is `User`). */
export type Success<R> = R extends Ok<infer T> ? T : never;

/** Extracts the failure type of a Result (`Failed<Result<User, IoError>>` is `IoError`). */
export type Failed<R> = R extends Err<infer E> ? E : never;

// ── Constructors ─────────────────────────────────────────────────────────────

// `ok()` with no argument is by far the most common Result in void-returning code
// (a write succeeded, a lock released). Returning one frozen singleton makes that path
// allocation-free. Freezing is what makes the sharing safe, and it happens exactly once.
const OK_VOID: Ok<void> = Object.freeze({ ok: true, value: undefined, error: undefined });

/** A successful Result carrying no value. Returns a shared frozen singleton. */
export function ok(): Ok<void>;
/** A successful Result carrying `value`. */
export function ok<const T>(value: T): Ok<T>;
export function ok(value?: unknown): Ok<unknown> {
  // `arguments.length` rather than `value === undefined` so an explicit `ok(undefined)`
  // still allocates: callers who pass a variable that happens to be undefined should not
  // silently share the frozen singleton and then be surprised it cannot be narrowed apart.
  return arguments.length === 0 ? OK_VOID : { ok: true, value, error: undefined };
}

/**
 * A failed Result carrying `error`.
 *
 * Key order matches `ok()` exactly. This is not cosmetic: V8 assigns a hidden class per
 * (key set × insertion order), so `{ok, value, error}` from both constructors means every
 * `result.ok` read in the program sees one map and stays monomorphic. Writing the natural
 * `{ok: false, error}` instead produces a second shape and pushes shared call sites into
 * polymorphic (and, mixed with a third shape, megamorphic) inline-cache states.
 */
export function err<const E>(error: E): Err<E> {
  return { ok: false, value: undefined, error };
}

// ── Guards ───────────────────────────────────────────────────────────────────

/** Whether `result` succeeded. Narrows `result` to `Ok<T>`. */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

/** Whether `result` failed. Narrows `result` to `Err<E>`. */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/**
 * Whether `value` is any Result at all — a structural check for values arriving from
 * outside the program (a WebSocket frame, a worker message, a cached JSON blob).
 *
 * Deliberately structural rather than branded. A Result is plain data whose whole purpose
 * is to cross realms intact, so a check that a foreign realm could fail would defeat it.
 */
export function isResult(value: unknown): value is Result<unknown, unknown> {
  return (
    typeof value === 'object' && value !== null && typeof (value as Ok<unknown>).ok === 'boolean'
  );
}

// ── Leaving the Result world ─────────────────────────────────────────────────

/**
 * Returns the success value, or throws the failure.
 *
 * The failure is rethrown **by identity** when it is already an `Error`, so the stack keeps
 * pointing at where the failure was created rather than at this line. That is usually what
 * you want while debugging; when you would rather record the unwrap site, use `expect()`,
 * which builds a fresh error and files the original under `cause`.
 *
 * Non-`Error` failures (a string, a `{code}` object, `null` — all legal `throw` operands in
 * JS, and all common in wire payloads) are wrapped so that whatever propagates upward is
 * guaranteed to have a `.stack` and a readable `.message`.
 */
export function unwrap<T>(result: Result<T, unknown>): T {
  if (result.ok) return result.value;
  if (result.error instanceof Error) throw result.error;
  throw new Error(`unwrap() on a failed Result: ${describe(result.error)}`, {
    cause: result.error,
  });
}

/**
 * Returns the success value, or throws `new Error(message, { cause: error })`.
 *
 * The counterpart to `unwrap()`: the thrown error's stack points *here*, at the code that
 * demanded a value, while `cause` preserves the original failure and its own stack. Use it
 * at the point where a failure stops being expected and becomes a bug.
 */
export function expect<T>(result: Result<T, unknown>, message: string): T {
  if (result.ok) return result.value;
  throw new Error(message, { cause: result.error });
}

/** Returns the success value, or `fallback` if the Result failed. */
export function unwrapOr<T, U>(result: Result<T, unknown>, fallback: U): T | U {
  return result.ok ? result.value : fallback;
}

/**
 * Returns the success value, or the result of `recover(error)`.
 *
 * The lazy sibling of `unwrapOr` — for fallbacks that cost something to build, and for
 * fallbacks that depend on *which* failure occurred.
 */
export function unwrapOrElse<T, E, U>(result: Result<T, E>, recover: (error: E) => U): T | U {
  return result.ok ? result.value : recover(result.error);
}

/**
 * Exhaustively handles both branches, returning whatever the taken branch returns.
 *
 * Worth reaching for when a Result is consumed as an *expression* (a JSX subtree, a
 * ternary's worth of logic, the tail of an arrow function). In statement position an
 * `if (!result.ok) return …` early exit reads better and allocates nothing — see the
 * "combinators are not the point" section of `docs/error-handling.md`.
 */
export function match<T, E, A, B>(
  result: Result<T, E>,
  handlers: { ok: (value: T) => A; err: (error: E) => B },
): A | B {
  return result.ok ? handlers.ok(result.value) : handlers.err(result.error);
}

// ── Transformations ──────────────────────────────────────────────────────────

/** Applies `fn` to a success value, passing failures through untouched. */
export function map<T, E, U>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Applies `fn` to a failure, passing successes through untouched. */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/** Chains a second fallible step onto a success, short-circuiting on failure. */
export function andThen<T, E, U, F>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, F>,
): Result<U, E | F> {
  return result.ok ? fn(result.value) : result;
}

// ── Collections ──────────────────────────────────────────────────────────────

/**
 * Collects an array of Results into a Result of an array, short-circuiting on the first
 * failure — the Result-shaped analogue of `Promise.all`.
 *
 * Unlike `Promise.all`, nothing is in flight while this runs: the work already happened, so
 * "short-circuit" only decides what is *reported*, never what is cancelled. When you need
 * every failure rather than the first, use `partition()`.
 */
export function all<T, E>(results: ReadonlyArray<Result<T, E>>): Result<T[], E> {
  const values: T[] = new Array(results.length);
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (!result.ok) return result;
    values[i] = result.value;
  }
  return ok(values);
}

/**
 * Splits Results into their successes and their failures, keeping both.
 *
 * This is the shape most batch work actually wants, and the one `Promise.all` cannot give
 * you: a rejected `Promise.all` discards the settled successes alongside the other
 * failures. Combine with `attempt()` — whose returned promise never rejects — to get
 * `Promise.allSettled` semantics with the failures already typed:
 *
 * ```ts
 * const results = await Promise.all(files.map((f) => attempt(() => readFile(f), errno())));
 * const { values, errors } = partition(results);
 * ```
 */
export function partition<T, E>(
  results: ReadonlyArray<Result<T, E>>,
): { values: T[]; errors: E[] } {
  const values: T[] = [];
  const errors: E[] = [];
  for (const result of results) {
    if (result.ok) values.push(result.value);
    else errors.push(result.error);
  }
  return { values, errors };
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * Best-effort one-line rendering of an arbitrary thrown value, used only in the message of
 * the wrapper `unwrap()` builds for non-`Error` failures.
 *
 * `String(value)` alone is not enough: it produces the useless `[object Object]` for plain
 * objects and *throws* for a null-prototype object or a Symbol, which would replace the
 * failure we are reporting with a different one.
 */
function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? Object.prototype.toString.call(value);
    } catch {
      // Circular structure, a BigInt field, or a throwing `toJSON`.
      return Object.prototype.toString.call(value);
    }
  }
  try {
    return String(value);
  } catch {
    // `String(Symbol())` throws; so does a null-prototype object with no `toString`.
    return typeof value;
  }
}
