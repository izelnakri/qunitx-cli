/**
 * `attempt` — exported as **`Result.try`**, the throw boundary of the error system: the one
 * place in a program where the `try`/`catch` *keyword* lives. Everywhere else, error handling
 * is a flat `if` on a `Result`.
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
 * const parsed = Result.try(JSON.parse, raw);                       // Result<unknown, unknown>
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

import { type Result, ok, err } from './result.ts';

/** `Result` for a synchronous source, a never-rejecting `Promise<Result>` for an async one. */
type Attempted<T> =
  T extends PromiseLike<unknown> ? Promise<Result<Awaited<T>, unknown>> : Result<T, unknown>;

/**
 * Calls `fn(...args)` and reflects the outcome into a `Result` — `Result.try`, shaped like
 * `Promise.try`. See the module doc for the flat-classification pattern this is half of.
 *
 * Because it owns the call, the *synchronous* prefix of async work is inside the boundary
 * too: `Result.try(fetch, url)` boxes the `TypeError` a malformed URL throws synchronously,
 * which `Result.try(() => …)(fetch(url))`-style pre-started promises never could.
 */
export function attempt<T, const A extends readonly unknown[]>(
  fn: (...args: A) => T,
  ...args: A
): Attempted<T> {
  let value: T;
  try {
    value = fn(...args);
  } catch (error) {
    return err(error) as Attempted<T>;
  }

  if (isThenable(value)) {
    // `Promise.resolve` first: a foreign or misbehaving thenable (calls its callbacks twice,
    // throws from `.then`) is normalised by the spec's resolution algorithm instead of being
    // trusted to behave. Both callbacks return, so the promise can never reject.
    return Promise.resolve(value).then(
      (resolved) => ok(resolved),
      (thrown) => err(thrown),
    ) as Attempted<T>;
  }
  return ok(value) as Attempted<T>;
}

/** Minimal shape of a Node system error, declared locally so this module stays runtime-free. */
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
 * const linked = await Result.try(fs.link, tmpPath, lockPath);
 * if (!linked.ok && !Result.isErrno(linked.error, 'EEXIST')) throw linked.error;
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
