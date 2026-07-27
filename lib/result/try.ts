/**
 * `tryCatch` — exported as **`Result.try`**, the throw boundary of the error system: the one
 * place in a program where the `try`/`catch` *keyword* lives (hence the bare-importable name —
 * `try` alone is reserved). Everywhere else, error handling is a flat `if` on a `Result`.
 *
 * The signature mirrors `Promise.try`: `Result.try(fn, ...args)` calls `fn(...args)` **now**
 * and reflects the outcome — a return becomes `Ok`, a throw becomes `Err`. A synchronous
 * source yields a `Result`; a source that returns a thenable yields a `Promise<Result>` that
 * **never rejects**, which is what makes `Promise.all(items.map((i) => Result.try(work, i)))`
 * safe: no fail-fast, no lost successes.
 *
 * It boxes **every** throw, because it is the raw edge — the counterpart of Lua's `pcall`.
 * The two-tier discipline (expected failure vs bug) is enforced *at the call site*, flat,
 * where the reader can see exactly what is declared:
 *
 * ```ts
 * import * as Result from './index.ts';
 * const raw = '{"n": 1}';
 *
 * const parsed = Result.try(JSON.parse, raw); // Result<unknown, unknown>
 * if (!parsed.ok && !(parsed.error instanceof SyntaxError)) throw parsed.error; // a bug stays a bug
 * ```
 *
 * That one visible rethrow line is the entire declaration mechanism. An earlier design put a
 * `{ catch: matcher }` grammar inside the boundary instead; it was removed because the flat
 * spelling says the same thing with zero machinery, composes with any guard the call site
 * already has (`instanceof`, a `Failure` factory's `.is`, {@link isErrno}), and keeps
 * `Result.try`'s signature identical to `Promise.try`'s — one shape to learn, arguments and
 * all. The async sibling for *declared* failures is `Task` (`lib/task/`), whose `.result()`
 * boxes only `Failure`s; `Result.try` is for the foreign edge where nothing is declared yet.
 *
 * `E` is always `unknown` — the honest type of a value caught sight-unseen. Narrow it with
 * the same guard you would have written in a `catch`, on the flat path.
 */

// The box lives HERE, and only here. Everywhere failures are *declared*, the bare
// `Result<T, E>` union replaces it — but this boundary catches `unknown`, which has no
// Failure brand to discriminate on, so success-vs-caught needs an explicit `ok` flag.
// Both variants share one key set and insertion order deliberately: V8 assigns a hidden
// class per (keys × order), so `outcome.ok` reads stay monomorphic.

/** The success variant of a caught outcome. `error` is present-but-undefined for shape stability. */
export type Ok<T> = {
  readonly ok: true;
  readonly value: T;
  readonly error?: undefined;
};

/** The caught variant. `value` is present-but-undefined for shape stability. */
export type Err<E> = {
  readonly ok: false;
  readonly value?: undefined;
  readonly error: E;
};

/**
 * What the boundary hands back: the value, or whatever was caught — `unknown`, honestly,
 * because a `catch` binding is exactly as untrustworthy.
 *
 * ```ts
 * import { tryCatch } from './try.ts';
 *
 * const parsed = tryCatch(JSON.parse, '{"n":1}');
 * if (parsed.ok) parsed.value; // narrowed; the else branch holds the caught unknown
 * ```
 */
export type Caught<T, E = unknown> = Ok<T> | Err<E>;

// Type-only: rescue()'s classifier is constrained to produce a Failure, keeping the module
// runtime-free (nothing from failure.ts is evaluated here).
import type { Any } from './failure.ts';

const okOf = <T>(value: T): Ok<T> => ({ ok: true, value, error: undefined });
const errOf = <E>(error: E): Err<E> => ({ ok: false, value: undefined, error });

/**
 * `Caught` for a synchronous source, a never-rejecting `Promise<Caught>` for an async one.
 *
 * The first arm handles an `any`-typed source — `JSON.parse`, the flagship caller. A
 * conditional type applied to `any` resolves to the *union* of both branches, which would
 * hand the caller the unusable `Promise<Result> | Result` (no `.ok` until narrowed by hand).
 * `0 extends 1 & T` is true only for `any`; such a source is treated as synchronous and its
 * value as `unknown` — the honest reading of `any`, and what the call site can branch on.
 */
type Tried<T> = 0 extends 1 & T
  ? Caught<unknown>
  : T extends PromiseLike<unknown>
    ? Promise<Caught<Awaited<T>>>
    : Caught<T>;

/**
 * Calls `fn(...args)` and reflects the outcome into a `Result` — `Result.try`, shaped like
 * `Promise.try`. See the module doc for the flat-classification pattern this is half of.
 *
 * ```ts
 * import { readFile } from 'node:fs/promises';
 * import * as Result from './index.ts';
 * const raw = '{"n": 1}';
 *
 * const parsed = Result.try(JSON.parse, raw); // sync source → Result, synchronously
 * if (!parsed.ok && !(parsed.error instanceof SyntaxError)) throw parsed.error;
 *
 * const read = await Result.try(() => readFile('config.json', 'utf8')); // async → Promise<Result>
 * ```
 *
 * Because it owns the call, the *synchronous* prefix of async work is inside the boundary
 * too: `Result.try(fetch, url)` boxes the `TypeError` a malformed URL throws synchronously,
 * which wrapping a pre-started `fetch(url)` promise never could.
 */
export function tryCatch<T, const A extends readonly unknown[]>(
  fn: (...args: A) => T,
  ...args: A
): Tried<T> {
  let value: T;
  try {
    value = fn(...args);
  } catch (error) {
    return errOf(error) as Tried<T>;
  }

  if (isThenable(value)) {
    // `Promise.resolve` first: a foreign or misbehaving thenable (calls its callbacks twice,
    // throws from `.then`) is normalised by the spec's resolution algorithm instead of being
    // trusted to behave. Both callbacks return, so the promise can never reject.
    return Promise.resolve(value).then(
      (resolved) => okOf(resolved),
      (thrown) => errOf(thrown),
    ) as Tried<T>;
  }
  return okOf(value) as Tried<T>;
}

/**
 * The outcome of `rescue()`: the bare `T | F` union, promise-wrapped when `fn` was async.
 * A leaking `any` collapses to `unknown` so it cannot pose as an inspected type.
 */
export type Rescued<T, F> = 0 extends 1 & T
  ? unknown
  : T extends PromiseLike<unknown>
    ? Promise<Awaited<T> | F>
    : T | F;

/**
 * Calls `fn(...args)` and returns the value **bare**, classifying any throw into the
 * declared Failure `classify` builds — the boundary and the declaration fused into one
 * expression, producing the bare union directly. The sync sibling of `Task#mapErr`: like
 * that adapter edge it deliberately catches *everything*, because this IS the edge where a
 * foreign throw becomes a declared failure — chain the original under `cause`. When the
 * boundary should stay raw and the declaration should be a separate visible rethrow line,
 * use `Result.try` instead.
 *
 * ```ts
 * import * as Result from './index.ts';
 * import * as Failure from './failure.ts';
 *
 * const BadRecord = Failure.define('BadRecord', (d: { line: number }) => `bad record at line ${d.line}`);
 *
 * Result.rescue(JSON.parse, (cause) => BadRecord({ line: 7 }, { cause }), '{"id":1}'); // { id: 1 } — bare
 * const failed = Result.rescue(JSON.parse, (cause) => BadRecord({ line: 8 }, { cause }), 'nope');
 * Failure.is(failed); // true — the throw arrived as the declared failure, bare and typed
 * ```
 */
export function rescue<T, F extends Any, const A extends readonly unknown[]>(
  fn: (...args: A) => T,
  classify: (cause: unknown) => F,
  ...args: A
): Rescued<T, F> {
  let value: T;
  try {
    value = fn(...args);
  } catch (cause) {
    return classify(cause) as Rescued<T, F>;
  }
  if (isThenable(value)) {
    return Promise.resolve(value).then(
      (resolved) => resolved,
      (cause) => classify(cause),
    ) as Rescued<T, F>;
  }
  return value as Rescued<T, F>;
}

/**
 * Minimal shape of a Node system error, declared locally so this module stays runtime-free.
 */
export interface ErrnoError extends Error {
  /** The symbolic error code, e.g. `ENOENT`. What {@link isErrno} matches on. */
  code?: string;
  /** The negated platform errno number. */
  errno?: number;
  /** The path the failing call was operating on, when the syscall takes one. */
  path?: string;
  /** The syscall that failed, e.g. `open`. */
  syscall?: string;
}

/**
 * Whether `value` is an `Error` carrying one of the given Node `code` strings — `ENOENT`,
 * `EADDRINUSE`, `EBUSY`. With no codes it matches any error that has a string `code` at all
 * (which includes Node's `ERR_*` internal errors, e.g. `ERR_MODULE_NOT_FOUND`).
 *
 * This is the guard for the flat classification line that follows a `Result.try` on Node
 * API calls — the discrimination the codebase used to perform as an `err.code !== 'X' &&
 * throw err` ladder in seven places:
 *
 * ```ts
 * import fs from 'node:fs/promises';
 * import * as Result from './index.ts';
 *
 * // Defined, not invoked: the rethrow line is the point, and a sandboxed doctest run
 * // would trip it with a permission error rather than the declared EEXIST.
 * async function publish(tmpPath: string, lockPath: string) {
 *   const linked = await Result.try(fs.link, tmpPath, lockPath);
 *   if (!linked.ok && !Result.isErrno(linked.error, 'EEXIST')) throw linked.error;
 *   return linked.ok;
 * }
 * ```
 */
export function isErrno(value: unknown, ...codes: string[]): value is ErrnoError {
  if (!(value instanceof Error)) return false;
  const code = (value as ErrnoError).code;
  return typeof code === 'string' && (codes.length === 0 || codes.includes(code));
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
