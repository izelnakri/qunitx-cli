/**
 * `Result<T, E>` — the success value itself, or the declared `Failure`. Bare. No box.
 *
 * This is the *value* half of the error system; `try.ts` is the *boundary* half and
 * `failure.ts` is the *taxonomy* half. The split mirrors Lua, where `error()`/`pcall()`
 * (boundary) and the `nil, err` return convention (value) are deliberately different
 * mechanisms used for different classes of problem — see `docs/error-handling.md`.
 *
 * There is no wrapper object. A `Failure` is branded and self-describing, so a container
 * around the pair would restate what the brand already answers: a producer returns the value
 * or returns the failure, and a consumer asks `Failure.is()` once and branches. This is Lua's
 * `nil, err` with the discrimination moved onto the error itself.
 *
 *  1. **The value travels naked.** No `.value` on the happy path, no allocation per outcome,
 *     nothing extra to serialize — the value is itself; the failure owns `toJSON`.
 *  2. **The discriminant is the Failure brand.** `Failure.is(x)` narrows both branches, and
 *     it keeps working on a value that crossed a WebSocket or a worker (failure.ts).
 *  3. **The one rule this buys nothing without:** the success type must never itself be a
 *     `Failure`. A function that *fetches failures as data* cannot use this shape — the two
 *     channels would be indistinguishable. The boundary (`try.ts`) keeps its `{ ok, value,
 *     error }` box for exactly that reason: a caught `unknown` has no brand to discriminate.
 */

import { isFailure, type Any } from './failure.ts';

/**
 * The success value or a declared failure — a bare union, discriminated by the `Failure`
 * brand.
 *
 * `E` should always be a `Failure` type: the brand is the only discriminant, so a
 * non-Failure `E` cannot be told apart from a success. It defaults to `Any` — the honest
 * "some declared failure" — rather than `unknown`, which would collapse the union.
 *
 * ```ts
 * import * as Result from './index.ts';
 *
 * const InvalidPort = Result.Failure.define('InvalidPort', (d: { raw: string }) => `not a port: ${d.raw}`);
 *
 * const parsePort = (raw: string): Result.Result<number, Result.Failure.Of<typeof InvalidPort>> =>
 *   /^\d+$/.test(raw) ? Number(raw) : InvalidPort({ raw });
 *
 * const port = parsePort('8080');
 * if (Result.Failure.is(port)) port.code; // narrowed to the failure here…
 * else port + 1; // …and to number here
 * ```
 */
export type Result<T, E = Any> = T | E;

// There is deliberately no `ok()`/`err()` pair and no `isOk`/`isErr`: the value is already
// itself, the failure is already itself, and `Failure.is()` is the one guard. The producers'
// entire vocabulary is `return value` and `return TheFailure({ … })`.

// ── Leaving the Result world ─────────────────────────────────────────────────

/**
 * Returns the success value, or throws the failure.
 *
 * The failure is thrown **by identity** — a `Failure` is an `Error`, so the stack keeps
 * pointing at where it was created rather than at this line. That is usually what you want
 * while debugging; when you would rather record the unwrap site, use `expect()`, which
 * builds a fresh error and files the original under `cause`.
 *
 * ```ts
 * import * as Result from './index.ts';
 *
 * import * as Args from '../args/index.ts';
 *
 * const flags = Result.unwrap(Args.parse('/repo')); // ParsedFlags, or the ParseFailure throws
 * ```
 */
export function unwrap<O>(outcome: O): Exclude<O, Any> {
  if (isFailure(outcome)) throw outcome;
  return outcome as Exclude<O, Any>;
}

/**
 * Returns the success value, or throws `new Error(message, { cause: failure })`.
 *
 * The counterpart to `unwrap()`: the thrown error's stack points *here*, at the code that
 * demanded a value, while `cause` preserves the original failure and its own stack. Use it
 * at the point where a failure stops being expected and becomes a bug.
 *
 * A plain `Error`, deliberately — never a `Failure`: every Task consumer (`result()`,
 * `match`, `unwrapOr`, `recover`) classifies a thrown Failure as *declared* and hands it
 * onward as a value, so a Failure here would let an upstream boundary silently un-crash the
 * bug this call just promoted. A plain Error can only travel to the crash boundary.
 *
 * ```ts
 * import * as Result from './index.ts';
 *
 * import * as Config from '../setup/config.ts';
 *
 * // Defined, not invoked: setup() assembles a real config. The doctest checks and
 * // evaluates the definition; only a caller would perform the work.
 * async function daemonBoot() {
 *   return Result.expect(await Config.setup().result(), 'daemon could not assemble its startup config');
 * }
 * ```
 */
export function expect<O>(outcome: O, message: string): Exclude<O, Any> {
  if (isFailure(outcome)) throw new Error(message, { cause: outcome });
  return outcome as Exclude<O, Any>;
}

/**
 * Returns the success value, or `fallback` if the outcome is a failure.
 *
 * ```ts
 * import * as Result from './index.ts';
 *
 * const TooBig = Result.Failure.define('TooBig', (d: { raw: string }) => `${d.raw} > 65535`);
 * const parsePort = (raw: string): Result.Result<number, Result.Failure.Of<typeof TooBig>> =>
 *   Number(raw) > 65535 ? TooBig({ raw }) : Number(raw);
 *
 * Result.unwrapOr(parsePort('99999'), 3000); // 3000
 * ```
 */
export function unwrapOr<O, U>(outcome: O, fallback: U): Exclude<O, Any> | U {
  return isFailure(outcome) ? fallback : (outcome as Exclude<O, Any>);
}

// There is deliberately no `map`/`mapErr`/`andThen`/`match` on a plain Result. A settled
// outcome is branched on with an `if`, which reads better and allocates nothing (see the
// "combinators are not the point" section of `docs/error-handling.md`); the *async* pipeline
// — where combinators earn their keep because the value is not here yet — lives on `Task`.

// ── Collections ──────────────────────────────────────────────────────────────

/**
 * Collects an array of outcomes into an array of values, short-circuiting on the first
 * failure — the Result-shaped analogue of `Promise.all`.
 *
 * Unlike `Promise.all`, nothing is in flight while this runs: the work already happened, so
 * "short-circuit" only decides what is *reported*, never what is cancelled. When you need
 * every failure rather than the first, use `partition()`.
 *
 * ```ts
 * import * as Result from './index.ts';
 *
 * import * as Failure from './failure.ts';
 * const loaded: Result.Result<{ name: string }, Failure.Any>[] = [{ name: 'esbuild-css' }];
 *
 * const plugins = Result.all(loaded); // as in Config's resolvePlugins
 * if (Failure.is(plugins)) console.error(plugins.message); // the first failure, context intact
 * ```
 */
export function all<O>(outcomes: ReadonlyArray<O>): Result<Exclude<O, Any>[], Extract<O, Any>> {
  const values: Exclude<O, Any>[] = new Array(outcomes.length);
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    if (isFailure(outcome)) return outcome as Extract<O, Any>;
    values[i] = outcome as Exclude<O, Any>;
  }
  return values;
}

/**
 * Splits outcomes into their successes and their failures, keeping both.
 *
 * This is the shape most batch work actually wants, and the one `Promise.all` cannot give
 * you: a rejected `Promise.all` discards the settled successes alongside the other
 * failures. `Task.results` produces exactly the array this consumes.
 *
 * ```ts
 * import * as Result from './index.ts';
 * import { Task } from '../task/index.ts';
 * import * as Failure from './failure.ts';
 *
 * const Rejected = Failure.define('Rejected', (d: { path: string }) => `rejected ${d.path}`);
 * const load = (path: string) =>
 *   Task<string, Failure.Of<typeof Rejected>>(() => {
 *     if (!path.startsWith('a')) throw Rejected({ path });
 *     return path;
 *   });
 *
 * const outcomes = await Task.results(['a.json', 'b.json'].map(load));
 * const { values, errors } = Result.partition(outcomes); // ['a.json'] / [Failure(Rejected)]
 * ```
 */
export function partition<O>(outcomes: ReadonlyArray<O>): {
  values: Exclude<O, Any>[];
  errors: Extract<O, Any>[];
} {
  const values: Exclude<O, Any>[] = [];
  const errors: Extract<O, Any>[] = [];
  for (const outcome of outcomes) {
    if (isFailure(outcome)) errors.push(outcome as Extract<O, Any>);
    else values.push(outcome as Exclude<O, Any>);
  }
  return { values, errors };
}
