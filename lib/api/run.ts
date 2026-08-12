import path from 'node:path';
import * as RunCommand from '../commands/run.ts';
import * as RunState from '../setup/run-state.ts';
import * as Options from './options.ts';
import * as Config from '../setup/config.ts';
import { Task } from '../task/index.ts';
import { findAPIReporterFrom } from './reporter.ts';
import { JUnitReporter } from '../reporters/junit.ts';
import { buildRows } from '../coverage/report.ts';
import type { BrowserLog, Notice, TestAssertion } from '../reporters/types.ts';
import type { InvalidOptionFailure, UserRunOptions } from './options.ts';
import type { ConfigFailure } from '../setup/config.ts';
import type { Config as ResolvedConfig } from '../types.ts';
import type { Counter } from '../types.ts';
import type { RunOutcome } from '../commands/run.ts';

/**
 * Every way a run can fail to happen: an option the runner will not accept, an unreadable input,
 * a directory with no `package.json` above it, an esbuild plugin that will not load.
 *
 * Note what is *not* here. Failing tests are not a failure — they are a {@link RunResult} with
 * `ok: false`. This union is only for the runner being unable to answer the question.
 *
 * ```ts
 * import { Failure } from '../task/index.ts';
 *
 * // Defined, not invoked: a real failure comes back from `run(...).result()`.
 * function explain(failure: RunFailure) {
 *   return `${failure.code}: ${Failure.format(failure)}`; // 'InvalidFlag: …'
 * }
 * ```
 */
export type RunFailure = ConfigFailure | InvalidOptionFailure;

/**
 * Runs the suite once in a real browser and resolves with everything it produced.
 *
 * Silent by default: with no `reporter`, nothing reaches stdout and the {@link RunResult} is the
 * entire output. Pass `reporter: 'tap'` (or `'spec'`, `'dot'`, `'github'`, or your own object)
 * to get the CLI's text as well — the result comes back either way.
 *
 * Lazy, because it is a {@link Task}: no browser starts until you await it. `await run(…)`
 * resolves the result or throws a {@link RunFailure}; `run(…).result()` hands back the bare
 * union instead, for code that would rather branch than catch.
 *
 * ```ts
 * import { run } from './run.ts';
 *
 * // Defined, not invoked: launches a browser and runs the project's tests.
 * async function checkCart() {
 *   const result = await run({ inputs: ['test/'], filter: 'Cart' });
 *   return result.ok ? 'green' : result.failures.map((test) => test.fullName);
 * }
 * ```
 */
export function run(options: UserRunOptions | string | string[] = {}): Task<RunResult, RunFailure> {
  return Task(async () => {
    // A declared config failure rejects this Task by identity, so `RunFailure` stays a union
    // `run(...).result()` can discriminate rather than a stringified message.
    const config = await Config.setup(Options.from(options));
    const signal = config.state.signal;
    // Checked before the run starts rather than during it: the first thing a run does is reset its
    // accumulators — the aborted flag among them — so a request made earlier would be cleared by
    // the very run it was meant to stop. The only honest answer is to not start one.
    if (signal?.aborted) return abort(config);

    const requestAbort = () => RunState.requestAbort(config.state);
    signal?.addEventListener('abort', requestAbort);
    try {
      return buildResult(config, await RunCommand.run(config));
    } finally {
      // One controller is often reused across several runs — a single "stop everything" button —
      // so a listener left behind per run on a long-lived signal really does accumulate.
      signal?.removeEventListener('abort', requestAbort);
    }
  });
}

/**
 * One finished test.
 *
 * ```ts
 * const test: TestResult = {
 *   name: 'sums line items',
 *   modules: ['Cart', 'totals'],
 *   fullName: 'Cart > totals: sums line items',
 *   status: 'failed',
 *   durationMs: 12,
 *   assertions: [{ passed: false, todo: false, actual: 3, expected: 4 }],
 *   file: 'test/cart-test.ts',
 * };
 * test.fullName; // exactly the string `--filter` matches against
 * ```
 */
export interface TestResult {
  /** The test's own name, without its modules. */
  name: string;
  /** The QUnit module path it was declared under; empty for a top-level test. */
  modules: string[];
  /** `"Module > Sub: test name"` — the string `filter` matches against. */
  fullName: string;
  /** QUnit's outcome for this test. */
  status: 'passed' | 'failed' | 'skipped' | 'todo';
  /** How long the test took, in milliseconds. */
  durationMs: number;
  /**
   * The test's assertions. QUnit trims these for passing tests, so this is populated for
   * failures and empty otherwise — a passing test's assertion count is not reported.
   */
  assertions: TestAssertion[];
  /**
   * Source file this test was declared in, relative to the project root, or `null`.
   *
   * Populated for **failures only**, and that is a limit of what QUnit reports rather than a
   * choice: `testEnd` carries no file, so the path is recovered from the failing assertion's
   * stack through the bundle's source map. A passing test leaves no stack to map.
   */
  file: string | null;
}

/**
 * Outcome totals for a run. `total` is the sum of the four buckets; `assertionsFailed` counts
 * individual assertions rather than tests, so one test can contribute several.
 *
 * The public name for the runner's own `Counter` — the same object, not a re-shaped copy, so the
 * numbers a reporter reads mid-run and the numbers on the result cannot disagree.
 *
 * ```ts
 * const counts: RunCounts =
 *   { total: 8, passed: 7, failed: 1, skipped: 0, todo: 0, assertionsFailed: 2 };
 * counts.passed + counts.failed === counts.total; // true when nothing was skipped
 * ```
 */
export type RunCounts = Counter;

/**
 * Per-file line coverage, when `coverage` was requested.
 *
 * ```ts
 * const file: FileCoverageSummary =
 *   { path: 'lib/cart.ts', coveredLines: 18, coverableLines: 20, percent: 90 };
 * file.percent; // 90
 * ```
 */
export interface FileCoverageSummary {
  /** Path relative to the project root, with forward slashes. */
  path: string;
  /** Lines executed at least once. */
  coveredLines: number;
  /** Lines the source map attributes to executable positions in the bundle. */
  coverableLines: number;
  /** `coveredLines / coverableLines`, as a percentage rounded to two decimals. */
  percent: number;
}

/**
 * The run's line coverage: one entry per source file, plus the totals across all of them.
 *
 * ```ts
 * const coverage: CoverageSummary = { files: [], coveredLines: 0, coverableLines: 0, percent: 0 };
 * coverage.files.length; // 0 — nothing coverable was found
 * ```
 */
export interface CoverageSummary {
  /** One entry per non-test source file the bundle mapped back to. */
  files: FileCoverageSummary[];
  /** Covered lines across every file. */
  coveredLines: number;
  /** Coverable lines across every file. */
  coverableLines: number;
  /** Overall percentage covered. */
  percent: number;
}

/**
 * What the run actually resolved to, after `package.json`, the defaults and the options were
 * merged — the answers a caller cannot otherwise recover from what it passed in.
 *
 * `port` is the sharp one: it auto-increments past a busy port, so the value bound is routinely
 * not the value requested.
 *
 * ```ts
 * const resolved: ResolvedRun = {
 *   browser: 'chromium', projectRoot: '/proj', output: '/proj/tmp', port: 1235,
 *   extensions: ['js', 'ts'], coverageFormats: [],
 * };
 * resolved.port; // 1235 — 1234 was taken
 * ```
 */
export interface ResolvedRun {
  /** The engine the tests ran in. */
  browser: 'chromium' | 'firefox' | 'webkit';
  /** Absolute path of the directory holding `package.json`. */
  projectRoot: string;
  /** Absolute path of the build output directory — where the bundle and artifacts landed. */
  output: string;
  /** The port actually bound, which may differ from the one requested. */
  port: number;
  /** File extensions treated as test files. */
  extensions: string[];
  /** Coverage artifact formats beyond the terminal summary. */
  coverageFormats: string[];
  /** The active test-name filter, when one was set. */
  filter?: string;
}

/**
 * Everything a finished run produced.
 *
 * **A run whose tests failed is a successful run.** `run()` resolves with `ok: false`; it does
 * not reject. Rejection is reserved for the run not happening — a bad option, an unreadable
 * input, a project with no `package.json`. Distinguishing "the suite says no" from "the runner
 * could not answer" is the whole point of the split, and it is what lets `catch` mean something.
 *
 * ```ts
 * // Defined, not invoked: a real result comes back from `run()`.
 * function summarize(result: RunResult) {
 *   return `${result.counts.passed}/${result.counts.total} passed in ${result.durationMs}ms`;
 * }
 * ```
 */
export interface RunResult {
  /** `true` when every test passed and nothing else went wrong. */
  ok: boolean;
  /** What the CLI would have exited with: `0` when `ok`, `1` otherwise. */
  exitCode: number;
  /** Wall-clock duration of the test phase, in milliseconds. */
  durationMs: number;
  /** Outcome totals. */
  counts: RunCounts;
  /** Every finished test, in the order the browser reported them. */
  tests: TestResult[];
  /** The subset of `tests` that failed — the list you almost always want first. */
  failures: TestResult[];
  /** Absolute paths of the test files this run executed — the ones scoped to, in a
   * filtered watch rerun, rather than everything being watched. */
  files: string[];
  /** Absolute paths of the test files with at least one failure, attributed via source maps. */
  failedFiles: string[];
  /** qunitx's own diagnostics for this run, in emission order. */
  notices: Notice[];
  /**
   * `console.*` calls and uncaught errors from the page — warnings and errors unless `debug`.
   *
   * Capped at the most recent {@link MAX_BROWSER_LOGS}; `browserLogsTruncated` counts what was
   * dropped. The cap is not tidiness: unlike tests and notices, page output is bounded by nothing
   * — one `for` loop around `console.warn` produced 50,001 entries and 252 MB of retained heap.
   * The newest are kept because they are the ones adjacent to the failure being diagnosed.
   */
  browserLogs: BrowserLog[];
  /** How many page-log entries were dropped to stay under the cap. `0` in every ordinary run. */
  browserLogsTruncated: number;
  /** Line coverage, or `null` when `coverage` was not requested. */
  coverage: CoverageSummary | null;
  /** The JUnit XML document, when `junit` was requested. Written to disk as well. */
  junitXml: string | null;
  /** Epoch ms when the test phase began. */
  startedAt: number;
  /** Epoch ms when it ended. */
  finishedAt: number;
  /** How many concurrent groups the files were split across; `1` for watch and single-file runs. */
  groupCount: number;
  /**
   * How the run finished: whether it got through everything it selected, and if not, what stopped
   * it. Distinct from {@link RunResult.ok}, which is the verdict — a `completed` run can be
   * entirely red, and an `aborted` one can have no failures at all.
   *
   * A boolean `aborted` could not tell a suite that stopped at its first failure from one that
   * genuinely has two tests — both come back `ok: false` with a small `counts.total` — so the
   * three endings are named instead:
   *
   * - `completed` — every selected test reached an outcome.
   * - `aborted` — something cut it short: `session.abort()`, the CLI's `qq`, or a `signal`. An
   *   already-aborted signal lands here too, having launched no browser at all.
   * - `failFast` — `failFast` was set and a test failed, so the rest of the queue was dropped.
   *   Reported whenever the policy ended the run, including when the failure was the last test.
   *
   * `completed` is the only one where `counts.total` is the whole selection. Check it before
   * reporting a red run as red, or a UI says "1 failure" about a suite it never finished.
   */
  status: 'completed' | 'aborted' | 'failFast';
  /** What the run resolved to — see {@link ResolvedRun}. */
  resolved: ResolvedRun;
}

/**
 * Assembles the run's result from the config's accumulated state, the run's outcome, and the
 * {@link APIReporter} that watched it.
 *
 * ```ts
 * import type { Config } from '../types.ts';
 * import type { RunOutcome } from '../commands/run.ts';
 *
 * // Defined, not invoked: reads the live counters off a resolved Config.
 * function assemble(config: Config, outcome: RunOutcome) {
 *   return buildResult(config, outcome);
 * }
 * ```
 */
export function buildResult(config: ResolvedConfig, outcome: RunOutcome): RunResult {
  // Both are recovered from the run's own reporter list rather than passed in: they ARE
  // reporters, `Config.setup` already holds them, and threading a second reference through every
  // caller would just be a second name for the same two objects.
  const reporter = findAPIReporterFrom(config);
  const junit = config.state.reporters.find((one) => one instanceof JUnitReporter);
  const junitXml = junit ? junit.xml() : null;
  const { counter, failedFiles, failedTests, coverage } = config.state.results;
  // QUnit's `testEnd` carries no file, so failures are attributed separately — through the
  // failing assertion's stack and the bundle's source map. Joining on the display name is what
  // puts that attribution back on the test it belongs to.
  const fileByTest = new Map(
    failedTests.map((record) => [`${record.module}\u0000${record.testName}`, record.file]),
  );
  const tests = reporter.tests.map((test) => ({
    ...test,
    file: fileByTest.get(`${test.modules.join(' > ')}\u0000${test.name}`) ?? null,
  }));

  return {
    ok: outcome.exitCode === 0,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    // Copied, not referenced: the runner mutates this object in place, and a watch rerun resets
    // it — a result holding the live object would silently rewrite its own history.
    counts: { ...counter },
    tests,
    failures: tests.filter((test) => test.status === 'failed'),
    // `lastRanFiles` rather than the whole fsTree: a watch-mode rerun scoped to one saved file
    // ran that file, not everything being watched. The batch runner sets it to the full set, so
    // the two agree there.
    files: config.state.group.lastRanFiles ?? Object.keys(config.fsTree),
    failedFiles: Array.from(failedFiles),
    notices: reporter.notices.slice(),
    browserLogs: reporter.browserLogs.slice(),
    browserLogsTruncated: reporter.browserLogsTruncated,
    coverage: coverage ? summarizeCoverage(config) : null,
    junitXml,
    startedAt: outcome.startedAt,
    finishedAt: outcome.finishedAt,
    groupCount: config.state.groupCount,
    // Derived, not tracked: `failFast` empties QUnit's queue inside the page, so the only signal
    // reaching here is that the policy was on and something failed.
    status: config.state.results.aborted
      ? 'aborted'
      : config.failFast && counter.failed > 0
        ? 'failFast'
        : 'completed',
    resolved: {
      browser: config.browser,
      projectRoot: config.projectRoot,
      output: path.resolve(config.projectRoot, config.output),
      port: config.port,
      extensions: config.extensions,
      coverageFormats: config.coverageFormats ?? [],
      ...(config.filter === undefined ? {} : { filter: config.filter }),
    },
  };
}

/**
 * The result of a run that was cancelled before it began: no browser, no tests, `aborted: true`.
 *
 * A result rather than a rejection, because cancelling is not failing — the caller asked for this
 * and gets the same shape back, so the code reading it needs no separate path. Exit 1, because a
 * run that produced no passing tests did not succeed; `aborted` is what says it was their doing.
 *
 * ```ts
 * import type { Config } from '../types.ts';
 *
 * // Defined, not invoked: needs a resolved Config.
 * function cancelled(config: Config) {
 *   return abort(config).status; // 'aborted'
 * }
 * ```
 */
export function abort(config: ResolvedConfig): RunResult {
  config.state.results.aborted = true;
  const now = Date.now();

  return buildResult(config, { exitCode: 1, durationMs: 0, startedAt: now, finishedAt: now });
}

/**
 * Folds the run's coverage into per-file counts plus the totals.
 *
 * `buildRows` does the folding — the same function the terminal report uses — rather than a
 * second walk of the collector. That is not only less code: it carries the Windows lesson, where
 * the two sides arrive in different shapes (fsTree paths use backslashes, source-map keys always
 * `/`) and a naive comparison silently leaks every test file into its own report.
 */
function summarizeCoverage(config: ResolvedConfig): CoverageSummary {
  const rows = buildRows(
    config.state.results.coverage!,
    new Set(Object.keys(config.fsTree)),
    config.projectRoot,
  );
  const coveredLines = rows.reduce((total, row) => total + row.covered, 0);
  const coverableLines = rows.reduce((total, row) => total + row.total, 0);

  return {
    files: rows.map((row) => ({
      path: row.displayPath,
      coveredLines: row.covered,
      coverableLines: row.total,
      percent: percentOf(row.covered, row.total),
    })),
    coveredLines,
    coverableLines,
    percent: percentOf(coveredLines, coverableLines),
  };
}

function percentOf(covered: number, coverable: number): number {
  return coverable === 0 ? 0 : Math.round((covered / coverable) * 10000) / 100;
}
