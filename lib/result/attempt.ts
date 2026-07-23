/**
 * `attempt` — the boundary half of the error system: the one place throwing code turns into
 * Result-returning code.
 *
 * This is Lua's `pcall` with one addition that changes its character completely: **a list of
 * expected failures**. `pcall(f)` catches everything, and so does every JavaScript port of it
 * (`try/catch`, `await-to-js`, `Result.fromThrowable`, `Effect.try`). Catching everything is
 * the defect at the centre of most error handling, because a `catch` cannot tell these apart:
 *
 *   - the network call failed          — expected; the caller has a plan
 *   - `config.retries` was `undefined` — a bug; the caller has no plan and never will
 *
 * Convert the first into a Result and the program gets better. Convert the second and the
 * program gets *worse* than it was with no error handling at all: a `TypeError` that would
 * have produced a stack trace pointing at the broken line is now a tidy failure value flowing
 * down the same path as a legitimate outcome, and the bug ships.
 *
 * So the recommended call always declares what it expects, in a labelled `catch`:
 *
 * ```ts
 * const parsed = Result.try(() => JSON.parse(raw), { catch: SyntaxError });
 * //    ^? Result<unknown, SyntaxError>       — a TypeError from a broken toJSON still throws
 * ```
 *
 * The primary spelling is `Result.try` — it reads as "try this, catch that", and the `catch:`
 * label names the second argument so a reader never has to guess what it is. `attempt` is the
 * same function under a name that also works as a bare import (`try` is a reserved word, so
 * `import { try }` is illegal while `Result.try` is fine).
 *
 * `Result.try(fn)` with no `catch` remains available and is exactly `pcall`; it types the
 * error as `unknown`, the honest description of a value you agreed to catch sight-unseen.
 */

import { type Result, ok, err } from './result.ts';

// ── Matchers ─────────────────────────────────────────────────────────────────

/** Minimal shape of a Node system error, declared locally so this module stays runtime-free. */
export interface ErrnoError extends Error {
  /** The symbolic error code, e.g. `ENOENT`. What `errno()` matches on. */
  code?: string;
  /** The negated platform errno number. */
  errno?: number;
  /** The path the failing call was operating on, when the syscall takes one. */
  path?: string;
  /** The syscall that failed, e.g. `open`. */
  syscall?: string;
}

/**
 * A declaration of an expected failure. Three forms are accepted:
 *
 *  - an `Error` constructor      — `SyntaxError`, `MyError`     (matched with `instanceof`)
 *  - a type-guard predicate      — `errno('ENOENT')`
 *  - anything with `.is()`       — a `Failure` factory from `failure.ts`
 */
export type Matcher<E> =
  | (abstract new (...args: never[]) => E)
  | ((value: unknown) => value is E)
  | { is(value: unknown): value is E };

/** Extracts the error type a single matcher proves. */
type MatchedError<M> = M extends { is(value: unknown): value is infer E }
  ? E
  : M extends (value: unknown) => value is infer E
    ? E
    : M extends abstract new (...args: never[]) => infer E
      ? E
      : never;

/** A `catch` declaration: one matcher, or a list of them. Omit it entirely to catch everything. */
export type CatchOption = Matcher<unknown> | readonly Matcher<unknown>[];

/** The `E` a `catch` declaration proves — the union of its matchers' error types. */
type CaughtError<C> = C extends readonly Matcher<unknown>[]
  ? MatchedError<C[number]>
  : C extends Matcher<unknown>
    ? MatchedError<C>
    : never;

/** `Result` for a synchronous source, `Promise<Result>` for an asynchronous one. */
type Attempted<T, E> =
  T extends PromiseLike<infer U> ? Promise<Result<Awaited<U>, E>> : Result<T, E>;

/**
 * Matches any `Error` carrying one of the given Node `code` strings — `ENOENT`, `EADDRINUSE`,
 * `EBUSY`. With no arguments it matches any error that has a string `code` at all.
 *
 * This is the discrimination the codebase already performs by hand in seven places
 * (`lib/setup/bind-server-to-port.ts:34`, `lib/commands/daemon/server.ts:74`,
 * `lib/utils/rm-retry.ts`, …), each spelling out the same `err.code !== 'X' && throw err`
 * ladder. Expressing it as a matcher makes the rethrow the default rather than a line
 * somebody has to remember to write.
 */
export function errno(...codes: string[]): (value: unknown) => value is ErrnoError {
  return (value: unknown): value is ErrnoError => {
    if (!(value instanceof Error)) return false;
    const code = (value as ErrnoError).code;
    return typeof code === 'string' && (codes.length === 0 || codes.includes(code));
  };
}

/**
 * Matches by `instanceof`, stated explicitly.
 *
 * `{ catch: SyntaxError }` already does this — a bare `Error` constructor is detected by
 * inspecting the prototype chain. Use this wrapper when the target is not an `Error`
 * subclass (a thrown `AbortSignal`, a custom sentinel class) and the detection would
 * otherwise treat the constructor as a predicate.
 */
export function instanceOf<E>(constructor: abstract new (...args: never[]) => E) {
  return (value: unknown): value is E => value instanceof constructor;
}

/** Matches if any of the given matchers match. Handy for naming a reusable failure set. */
export function anyOf<const M extends readonly Matcher<unknown>[]>(
  ...matchers: M
): (value: unknown) => value is MatchedError<M[number]> {
  return (value: unknown): value is MatchedError<M[number]> =>
    matchers.some((matcher) => matches(matcher, value));
}

// ── attempt ──────────────────────────────────────────────────────────────────

/**
 * Runs `source`, returning `Ok` with its value or `Err` with a **declared** failure.
 *
 * `options.catch` declares what is expected — a matcher, or a list of them. Anything it does
 * not cover is rethrown, so bugs keep behaving like bugs. Omit `catch` entirely and everything
 * is caught and typed `unknown` (that is `pcall`); pass `{ catch: [] }` and nothing is caught.
 *
 * `source` may be a function or a promise. A function is strongly preferred: it puts the
 * synchronous part of the work inside the boundary too. `Result.try(() => fetch(url))` catches
 * a `TypeError` from a malformed URL — which `fetch` throws synchronously — while
 * `Result.try(fetch(url))` cannot, because that throw happens while evaluating the argument.
 *
 * Returns a `Result` for sync sources and a `Promise<Result>` for async ones, decided at
 * runtime by whether the returned value is thenable, and mirrored in the type. The returned
 * promise **never rejects for a declared failure**, which is what makes
 * `Promise.all(items.map((i) => Result.try(...)))` safe: no fail-fast, no lost successes.
 */
export function attempt<T>(source: (() => T) | PromiseLike<T>): Attempted<T, unknown>;
/** Runs `source`, typing the failure as whatever `options.catch` declares. */
export function attempt<T, const C extends CatchOption>(
  source: (() => T) | PromiseLike<T>,
  options: { catch: C },
): Attempted<T, CaughtError<C>>;
export function attempt<T>(
  source: (() => T) | PromiseLike<T>,
  options?: { catch?: CatchOption },
): Attempted<T, unknown> {
  const matchers = normalizeCatch(options);
  let value: unknown;
  try {
    value = typeof source === 'function' ? (source as () => T)() : source;
  } catch (thrown) {
    return settle(thrown, matchers) as Attempted<T, unknown>;
  }

  if (isThenable(value)) {
    return value.then(
      (resolved) => ok(resolved),
      (thrown) => settle(thrown, matchers),
    ) as Attempted<T, unknown>;
  }
  return ok(value) as Attempted<T, unknown>;
}

/**
 * Lua's `pcall`: runs `source` and catches everything, with no declaration of intent.
 *
 * A named alias for `Result.try(source)` rather than a second implementation, so that a
 * reader — or a `grep` before a refactor — can find every unfiltered boundary in a codebase
 * by searching one word. Reach for it at process edges (a plugin call, a user-supplied
 * callback, a top-level handler) where "anything at all may go wrong and this process must
 * survive it" is genuinely the specification.
 */
export function pcall<T>(source: (() => T) | PromiseLike<T>): Attempted<T, unknown> {
  return attempt(source);
}

/**
 * Lua's `xpcall`: runs `source` and passes any thrown value through `handler` on the way out.
 *
 * **The semantics differ from Lua's, and the difference is not fixable.** In Lua the message
 * handler runs *at the point of the error, before the stack unwinds*, which is why
 * `xpcall(f, debug.traceback)` can capture a live traceback. JavaScript has one-phase
 * exception handling: by the time a `catch` runs, the stack is already gone. What survives is
 * whatever the `Error` object snapshotted in its constructor — so you get the frames, but not
 * the live locals, and nothing at all if the thrown value was not an `Error`.
 *
 * The practical use is therefore narrower than Lua's: normalising or enriching a failure at
 * the boundary, typically `xpcall(work, (e) => Wrapped({ during: 'work' }, { cause: e }))`.
 */
export function xpcall<T, E>(
  source: (() => T) | PromiseLike<T>,
  handler: (thrown: unknown) => E,
): Attempted<T, E> {
  let value: unknown;
  try {
    value = typeof source === 'function' ? (source as () => T)() : source;
  } catch (thrown) {
    return err(handler(thrown)) as Attempted<T, E>;
  }

  if (isThenable(value)) {
    return value.then(
      (resolved) => ok(resolved),
      (thrown) => err(handler(thrown)),
    ) as Attempted<T, E>;
  }
  return ok(value) as Attempted<T, E>;
}

// ── Internals ────────────────────────────────────────────────────────────────

// `null` means "no `catch` was declared" — catch everything (pcall). An explicit list, even an
// empty one, means "these and only these", so `{ catch: [] }` declares that nothing is expected.
function normalizeCatch(options?: { catch?: CatchOption }): readonly Matcher<unknown>[] | null {
  const declared = options?.catch;
  if (declared === undefined) return null;
  return Array.isArray(declared) ? declared : [declared as Matcher<unknown>];
}

/** Converts a thrown value to `Err` if it was declared, and rethrows it if it was not. */
function settle(
  thrown: unknown,
  matchers: readonly Matcher<unknown>[] | null,
): Result<never, unknown> {
  if (matchers === null) return err(thrown);
  for (const matcher of matchers) {
    if (matches(matcher, thrown)) return err(thrown);
  }
  throw thrown;
}

function matches(matcher: Matcher<unknown>, value: unknown): boolean {
  // `.is` is tested first because the three matcher forms are not disjoint at runtime: a
  // `Failure` factory is a *callable* object that also carries `.is`. Dispatching on
  // `typeof === 'function'` first would invoke the factory as though it were a predicate —
  // which mints a brand-new Failure, returns a truthy object rather than `true`, and so
  // silently reports "no match" for the one matcher form most likely to be used.
  if (typeof (matcher as { is?: unknown }).is === 'function') {
    return (matcher as { is(value: unknown): boolean }).is(value);
  }
  if (typeof matcher === 'function') {
    // A constructor and a type-guard predicate are both `function`, and both are legal
    // matchers, so they have to be told apart. `Error` subclasses are the only constructors
    // this form accepts — anything else must go through `instanceOf()`, which is unambiguous.
    return isErrorConstructor(matcher)
      ? value instanceof (matcher as abstract new (...args: never[]) => unknown)
      : (matcher as (value: unknown) => boolean)(value) === true;
  }
  return false;
}

function isErrorConstructor(fn: unknown): boolean {
  const prototype = (fn as { prototype?: unknown }).prototype;
  return prototype === Error.prototype || prototype instanceof Error;
}

/**
 * Whether `value` is thenable — the Promises/A+ duck-type, not `instanceof Promise`.
 *
 * Deliberately structural: a foreign realm's promise, a Bluebird promise, and a hand-rolled
 * thenable all need to take the async path here, and none of them are `instanceof` this
 * realm's `Promise`.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}
