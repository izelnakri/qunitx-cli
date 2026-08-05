/**
 * The qunitx JS API: run your QUnit tests in a real browser from Node.js or Deno, and get the
 * results back as a value.
 *
 * ```ts
 * import { run } from './run.ts';
 *
 * // Defined, not invoked: launches a browser and runs the project's tests.
 * async function check() {
 *   const result = await run('test/');
 *   return result.ok ? 0 : result.failures.length;
 * }
 * ```
 *
 * Four things worth knowing before reading further:
 *
 * - **Nothing is printed unless you ask.** No `reporter`, no output — the returned
 *   {@link RunResult} is the whole answer. `reporter: 'tap'` gets the CLI's text as well.
 * - **Failing tests are not an error.** `run()` resolves with `ok: false`; it rejects only when
 *   the run could not happen at all (a bad option, an unreadable input, no `package.json`).
 * - **Everything is lazy.** These return a {@link Task} — a Promise superset — so nothing starts
 *   until you await it, and `.result()` hands back a `Result` union instead of throwing.
 * - **It is the same engine as the CLI.** `run(options)` and `qunitx <flags>` assemble the same
 *   config and take the same code path; there is no second implementation to drift.
 */

export { run, type RunFailure } from './run.ts';
export { runSession, type RunSession } from './session.ts';
export { watch, type WatchSession } from './watch.ts';
export { search, type SearchMatch, type SearchResult } from './search.ts';
export { init, generate, type InitOptions, type GenerateOptions } from './scaffold.ts';
/**
 * Daemon control: `start`, `stop`, `status`, and a `run` that reuses the daemon's warm browser
 * and returns the same {@link RunResult} a local run does.
 *
 * ```ts
 * import * as daemon from './daemon.ts';
 *
 * // Defined, not invoked: spawns and talks to a real background process.
 * async function warmRun() {
 *   await daemon.start();
 *   return await daemon.run({ inputs: ['test/'] });
 * }
 * ```
 */
export * as daemon from './daemon.ts';
export type { DaemonRunOptions, DaemonStatus } from './daemon.ts';

export type { RunOptions, ReporterOption, WritableLike } from './options.ts';
export type {
  RunResult,
  RunCounts,
  TestResult,
  ResolvedRun,
  CoverageSummary,
  FileCoverageSummary,
} from './result.ts';

/**
 * The live view of a run: what a session yields, in the order it happened.
 *
 * The fine-grained counterpart to {@link RunResult} — the same run, as it happens rather than once
 * it is over. Both sessions produce the same events, so a progress display works against either.
 */
export type { RunEvent } from './events.ts';

/**
 * The reporter contract and its payloads. Implement {@link Reporter} to observe a run as it
 * happens; pass the instance as `reporter`.
 */
export type {
  Reporter,
  ReporterName,
  Notice,
  BrowserLog,
  TestAssertion,
  TestDetails,
  RunStartInfo,
  RunEndInfo,
} from '../reporters/types.ts';
export { REPORTERS } from '../reporters/types.ts';

/**
 * Where reporters write. `processOutput` is the CLI's, `silentOutput` discards, and
 * `streamOutput` adapts anything with a `write(string)`.
 */
export { type Output, processOutput, silentOutput, streamOutput } from '../reporters/output.ts';

/**
 * The error-handling primitives these functions are built on.
 *
 * `Task<T, E>` is what every entry point returns: a lazy, retryable Promise superset whose
 * declared failures are `Failure` rejections. `Failure` is the taxonomy — `Failure.is(x)`
 * discriminates one, `Failure.format(x)` renders it. `Result<T, E>` is the bare `T | E` union
 * `task.result()` settles to, for callers who would rather branch than catch.
 *
 * ```ts
 * import { run } from './run.ts';
 * import { Failure } from './failure.ts';
 *
 * // Defined, not invoked: launches a browser.
 * async function branchOnFailure() {
 *   const outcome = await run().result();
 *   return Failure.is(outcome) ? Failure.format(outcome) : outcome.counts;
 * }
 * ```
 */
export { Task, type Result } from '../task/index.ts';

export { Failure, type AnyFailure } from './failure.ts';
