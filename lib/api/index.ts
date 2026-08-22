/**
 * The qunitx JS API: run your QUnit tests in a real browser from Node.js or Deno, and get the
 * results back as a value.
 *
 * ```ts
 * import { test } from './test.ts';
 *
 * // Defined, not invoked: launches a browser and runs the project's tests.
 * async function check() {
 *   const result = await test('test/');
 *   return result.ok ? 0 : result.failures.length;
 * }
 * ```
 *
 * Two verbs, mirroring the CLI: {@link test} runs a suite (`qunitx test/`), {@link run} executes
 * ONE file as a plain script (`qunitx run seed.ts`). **`run` was the suite verb until the script
 * verb needed the name** — if you are upgrading, rename those calls to `test`.
 *
 * Four things worth knowing before reading further:
 *
 * - **Nothing is printed unless you ask.** No `reporter`, no output — the returned
 *   {@link RunResult} is the whole answer. `reporter: 'tap'` gets the CLI's text as well.
 * - **Failing tests are not an error.** `test()` resolves with `ok: false`; it rejects only when
 *   the run could not happen at all (a bad option, an unreadable input, no `package.json`).
 * - **Everything is lazy.** These return a {@link Task} — a Promise superset — so nothing starts
 *   until you await it, and `.result()` hands back a `Result` union instead of throwing.
 * - **It is the same engine as the CLI.** `test(options)` and `qunitx <flags>` assemble the same
 *   config and take the same code path; there is no second implementation to drift.
 *
 * @module
 */

import { is, format, hasCode, type Any } from '../result/failure.ts';

export { test, type RunFailure } from './test.ts';
/**
 * Runs ONE file as a plain script in the browser, the API twin of `qunitx run <file>`.
 *
 * The counterpart to {@link test}: that verb runs a suite and reports tests, this one executes a
 * file and reports its exit code.
 *
 * **Migrating:** `run` used to be the suite verb — today's {@link test}. `run({ inputs })`,
 * `run('tests/')` and `run(['a.ts'])` are now refused with a message naming `test()`, because
 * running them as scripts silently instead would be worse than an error. The one call this cannot
 * catch is `run('single-file.ts')`, which was legal for a suite and is legal for a script: the
 * return type differs, so TypeScript flags it, but untyped callers must check that one by hand.
 */
export { run, NotAScriptFile } from './run.ts';
export type { ScriptOptions, ScriptResult, ScriptFailure } from './run.ts';
export { openSession, type SessionOptions, type TestSession } from './session.ts';
export { watch, type SessionPatch, type WatchSession } from './watch.ts';
export { search, type SearchMatch, type SearchResult, type UnlistableCounts } from './search.ts';
export { repl, type ReplFailure } from './repl.ts';
export type { ReplSession, ReplResult, ReplStartFailure } from '../repl/session.ts';
// Straight off the commands rather than through a wrapper module: they already return a Task
// and already carry these docs, so re-exporting them under their public names is the whole job.
export { run as init, type InitOptions, type InitResult } from '../commands/init.ts';
export {
  run as generate,
  type GenerateOptions,
  type GenerateResult,
} from '../commands/generate.ts';
/**
 * Daemon control: `start`, `stop`, `status`, and a `test` that reuses the daemon's warm browser
 * and returns the same {@link RunResult} a local run does.
 *
 * ```ts
 * import * as Daemon from './daemon.ts';
 *
 * // Defined, not invoked: spawns and talks to a real background process.
 * async function warmRun() {
 *   await Daemon.start();
 *   return await Daemon.test({ inputs: ['test/'] });
 * }
 * ```
 */
export * as Daemon from './daemon.ts';
export type { DaemonRunOptions, DaemonRunFailure, DaemonStatus } from './daemon.ts';

/**
 * Rejects options the runner will not accept — a browser that does not exist, a port out of
 * range — without launching anything. `test()` does this itself; call it directly to check a set
 * of options before committing to a run.
 */
export { validate, InvalidOption, type InvalidOptionFailure } from './options.ts';
export type { UserRunOptions, ReporterOption } from './options.ts';
export type {
  RunResult,
  RunCounts,
  RunGroup,
  TestResult,
  ResolvedRun,
  CoverageSummary,
  FileCoverageSummary,
} from './test.ts';

/**
 * The live view of a run: what a session yields, in the order it happened.
 *
 * The fine-grained counterpart to {@link RunResult} — the same run, as it happens rather than once
 * it is over. Both sessions produce the same events, so a progress display works against either.
 */
export type { RunEvent } from './reporter.ts';

/**
 * The reporter contract and its payloads. Implement {@link Reporter} to observe a run as it
 * happens; pass the instance as `reporter`.
 */
export type {
  Reporter,
  ReporterContext,
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
 * Where reporters write. `processConsole` is the CLI's, `silentConsole` discards, and
 * `streamConsole` adapts anything with a `write(string)`.
 */
export { type Console, processConsole, silentConsole, streamConsole } from '../console.ts';

/**
 * The error-handling primitives these functions are built on.
 *
 * `Task<T, E>` is what every entry point returns: a lazy, retryable Promise superset whose
 * declared failures are `Failure` rejections. `Failure` is the taxonomy — `Failure.is(x)`
 * discriminates one, `Failure.format(x)` renders it. `Result<T, E>` is the bare `T | E` union
 * `task.result()` settles to, for callers who would rather branch than catch.
 *
 * ```ts
 * import { test } from './test.ts';
 * import { Failure } from './index.ts';
 *
 * // Defined, not invoked: launches a browser.
 * async function branchOnFailure() {
 *   const outcome = await test().result();
 *   return Failure.is(outcome) ? Failure.format(outcome) : outcome.counts;
 * }
 * ```
 */
export { Task, type Result } from '../task/index.ts';

/**
 * The lazy pipeline the sessions hand back: `session.events()` and `w.results()` are Streams, so
 * the combinators are already attached. Re-exported so a consumer of this API never has to reach
 * past it for the type.
 */
export { Stream } from '../stream/index.ts';

/**
 * A declared failure: something the runner decided it could not do, carrying a `code` to branch
 * on and a `message` to show.
 */
export type AnyFailure = Any;

/**
 * The failure taxonomy, as this API's public surface.
 *
 * A hand-picked subset rather than the internal module re-exported whole: these three are what a
 * consumer needs in order to handle a failure, and freezing only them leaves the rest — `define`,
 * the tracing hooks, the ignore channel — free to change without breaking anyone.
 *
 * ```ts
 * import { Failure } from './index.ts';
 *
 * Failure.is(new Error('plain')); // false — only declared failures answer to this
 * ```
 */
export const Failure: {
  /** Narrows an unknown value to a declared failure. The guard to reach for after `.result()`. */
  is: (value: unknown) => value is AnyFailure;
  /** Renders a failure as the one-line message the CLI would print. */
  format: (error: unknown, options?: { stacks?: boolean }) => string;
  /** Narrows to a specific set of codes, for handling some failures and rethrowing the rest. */
  hasCode: <const Codes extends readonly string[]>(
    value: unknown,
    ...codes: Codes
  ) => value is AnyFailure & { code: Codes[number] };
} = { is, format, hasCode };
