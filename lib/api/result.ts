import type { Config } from '../types.ts';
import type {
  BrowserLog,
  Notice,
  Reporter,
  TestAssertion,
  TestDetails,
} from '../reporters/types.ts';
import { buildRows } from '../coverage/report.ts';
import type { RunOutcome } from '../commands/run.ts';

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
}

/**
 * Outcome totals for a run. `total` is the sum of the four buckets; `assertionsFailed` counts
 * individual assertions rather than tests, so one test can contribute several.
 *
 * ```ts
 * const counts: RunCounts =
 *   { total: 8, passed: 7, failed: 1, skipped: 0, todo: 0, assertionsFailed: 2 };
 * counts.passed + counts.failed === counts.total; // true when nothing was skipped
 * ```
 */
export interface RunCounts {
  /** Every test that reached an outcome. */
  total: number;
  /** Tests where every assertion held. */
  passed: number;
  /** Tests with at least one failing assertion, or that threw. */
  failed: number;
  /** Tests declared with `test.skip`. */
  skipped: number;
  /** Tests declared with `test.todo` — expected to fail, and not counted as failures. */
  todo: number;
  /** Failing assertions across the whole run, excluding those inside `todo` tests. */
  assertionsFailed: number;
}

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
}

/**
 * How many page-log entries a result retains. Tests and notices are bounded by the suite; page
 * output is bounded by nothing a test runner controls, so this is the one channel that needs a
 * ceiling. Generous enough that a real run never reaches it.
 *
 * ```ts
 * MAX_BROWSER_LOGS; // 1000
 * ```
 */
export const MAX_BROWSER_LOGS = 1000;

/**
 * The reporter that turns a run into a value: it records what happened instead of printing it.
 *
 * Attached by the JS API to every run, alongside whatever reporters the caller asked for — so
 * `reporter: 'tap'` still streams TAP *and* still resolves with a full {@link RunResult}.
 *
 * ```ts
 * import type { Config } from '../types.ts';
 *
 * const collector = new Collector();
 * collector.onTestEnd({} as Config, { status: 'passed', fullName: ['Math', 'adds'], runtime: 2 });
 * collector.tests[0].fullName; // 'Math: adds'
 * ```
 */
export class Collector implements Reporter {
  /** Every finished test, in arrival order. */
  readonly tests: TestResult[] = [];
  /** Every diagnostic, in emission order. */
  readonly notices: Notice[] = [];
  /** The most recent page console calls and uncaught errors, capped at {@link MAX_BROWSER_LOGS}. */
  readonly browserLogs: BrowserLog[] = [];
  /** How many page-log entries the cap dropped. */
  browserLogsTruncated = 0;

  /**
   * Drops everything from a previous run. Watch sessions reuse one collector across reruns, so
   * this is what keeps rerun N's result from containing rerun N-1's tests.
   *
   * ```ts
   * const collector = new Collector();
   * collector.notices.push({ level: 'info', message: 'stale' });
   * collector.reset();
   * collector.notices.length; // 0
   * ```
   */
  reset(): void {
    this.tests.length = 0;
    this.notices.length = 0;
    this.browserLogs.length = 0;
    this.browserLogsTruncated = 0;
  }

  /**
   * Records one finished test.
   *
   * ```ts
   * import type { Config } from '../types.ts';
   *
   * const collector = new Collector();
   * collector.onTestEnd({} as Config, { status: 'failed', fullName: ['Cart', 'adds'], runtime: 4 });
   * collector.tests[0].status; // 'failed'
   * ```
   */
  onTestEnd(_config: Config, details: TestDetails): void {
    this.tests.push(toTestResult(details));
  }

  /**
   * Records one diagnostic.
   *
   * ```ts
   * import type { Config } from '../types.ts';
   *
   * const collector = new Collector();
   * collector.onNotice({} as Config, { level: 'warning', message: 'No tests matched' });
   * collector.notices[0].level; // 'warning'
   * ```
   */
  onNotice(_config: Config, notice: Notice): void {
    this.notices.push(notice);
  }

  /**
   * Records one page console call or uncaught error.
   *
   * ```ts
   * import type { Config } from '../types.ts';
   *
   * const collector = new Collector();
   * collector.onBrowserLog({} as Config, { type: 'error', text: 'boom', args: [] });
   * collector.browserLogs[0].text; // 'boom'
   * ```
   */
  onBrowserLog(_config: Config, log: BrowserLog): void {
    this.browserLogs.push(log);
    // Drop from the front: a flood's newest lines are the ones next to whatever went wrong.
    if (this.browserLogs.length > MAX_BROWSER_LOGS) {
      this.browserLogs.shift();
      this.browserLogsTruncated++;
    }
  }
}

/**
 * Assembles the run's result from the config's accumulated state, the run's outcome, and the
 * collector that watched it.
 *
 * ```ts
 * import type { Config } from '../types.ts';
 * import type { RunOutcome } from '../commands/run.ts';
 *
 * // Defined, not invoked: reads the live counters off a resolved Config.
 * function assemble(config: Config, outcome: RunOutcome) {
 *   return buildResult(config, outcome, new Collector(), null);
 * }
 * ```
 */
export function buildResult(
  config: Config,
  outcome: RunOutcome,
  collector: Collector,
  junitXml: string | null,
): RunResult {
  const { counter, failedFiles, coverage } = config.state.results;
  const tests = collector.tests.slice();

  return {
    ok: outcome.exitCode === 0,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    counts: {
      total: counter.testCount,
      passed: counter.passCount,
      failed: counter.failCount,
      skipped: counter.skipCount,
      todo: counter.todoCount,
      assertionsFailed: counter.errorCount,
    },
    tests,
    failures: tests.filter((test) => test.status === 'failed'),
    // `lastRanFiles` rather than the whole fsTree: a watch-mode rerun scoped to one saved file
    // ran that file, not everything being watched. The batch runner sets it to the full set, so
    // the two agree there.
    files: config.state.group.lastRanFiles ?? Object.keys(config.fsTree),
    failedFiles: Array.from(failedFiles),
    notices: collector.notices.slice(),
    browserLogs: collector.browserLogs.slice(),
    browserLogsTruncated: collector.browserLogsTruncated,
    coverage: coverage ? summarizeCoverage(config) : null,
    junitXml,
  };
}

/**
 * Projects one QUnit `testEnd` payload into a {@link TestResult}. QUnit's `fullName` is
 * `[...modules, testName]`; the joined display form matches what `filter` matches against —
 * modules separated by ` > `, the test name after a `: `.
 *
 * ```ts
 * toTestResult({ status: 'passed', fullName: ['Cart', 'adds item'], runtime: 2 }).fullName;
 * // 'Cart: adds item'
 * ```
 */
export function toTestResult(details: TestDetails): TestResult {
  const modules = details.fullName.slice(0, -1);
  const name = details.fullName[details.fullName.length - 1] ?? '';

  return {
    name,
    modules,
    fullName: modules.length > 0 ? `${modules.join(' > ')}: ${name}` : name,
    status: details.status as TestResult['status'],
    durationMs: details.runtime,
    assertions: details.assertions ?? [],
  };
}

/**
 * Folds the run's coverage into per-file counts plus the totals.
 *
 * `buildRows` does the folding — the same function the terminal report uses — rather than a
 * second walk of the collector. That is not only less code: it carries the Windows lesson, where
 * the two sides arrive in different shapes (fsTree paths use backslashes, source-map keys always
 * `/`) and a naive comparison silently leaks every test file into its own report.
 */
function summarizeCoverage(config: Config): CoverageSummary {
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
