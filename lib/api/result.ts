import type { Config } from '../types.ts';
import type {
  BrowserLog,
  Notice,
  Reporter,
  TestAssertion,
  TestDetails,
} from '../reporters/types.ts';
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
  /** `console.*` calls and uncaught errors from the page. Warnings and errors unless `debug`. */
  browserLogs: BrowserLog[];
  /** Line coverage, or `null` when `coverage` was not requested. */
  coverage: CoverageSummary | null;
  /** The JUnit XML document, when `junit` was requested. Written to disk as well. */
  junitXml: string | null;
}

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
  /** Every page console call and uncaught error, in arrival order. */
  readonly browserLogs: BrowserLog[] = [];

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

/** Folds the raw per-line coverage map into per-file counts plus the run totals. */
function summarizeCoverage(config: Config): CoverageSummary {
  const collected = config.state.results.coverage!;
  const testFiles = new Set(Object.keys(config.fsTree));
  const files: FileCoverageSummary[] = [];
  let coveredLines = 0;
  let coverableLines = 0;

  for (const [absolutePath, fileCoverage] of collected) {
    // Same exclusion the terminal report applies: a test file's own coverage is noise, and
    // node_modules never reached the collector.
    if (testFiles.has(absolutePath)) continue;
    const coverable = fileCoverage.coverable.size;
    if (coverable === 0) continue;
    let covered = 0;
    for (const line of fileCoverage.coverable) {
      if ((fileCoverage.covered.get(line) ?? 0) > 0) covered++;
    }
    coveredLines += covered;
    coverableLines += coverable;
    files.push({
      path: displayPath(absolutePath, config.projectRoot),
      coveredLines: covered,
      coverableLines: coverable,
      percent: percentOf(covered, coverable),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));

  return { files, coveredLines, coverableLines, percent: percentOf(coveredLines, coverableLines) };
}

function percentOf(covered: number, coverable: number): number {
  return coverable === 0 ? 0 : Math.round((covered / coverable) * 10000) / 100;
}

function displayPath(absolutePath: string, projectRoot: string): string {
  return absolutePath.startsWith(`${projectRoot}/`)
    ? absolutePath.slice(projectRoot.length + 1)
    : absolutePath.replaceAll('\\', '/');
}
