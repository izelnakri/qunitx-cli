import type { Plugin as EsbuildPlugin } from 'esbuild';

/**
 * The public JS API's types. Everything here is stable surface: it is intentionally a
 * different vocabulary from `lib/types.ts#Config` and `lib/reporter/types.ts#TestDetails`,
 * which are internal and carry runtime slots (browser handles, esbuild contexts, WebSocket
 * callbacks) that no consumer should see or depend on.
 */

/** Browser engine the tests execute in. */
export type BrowserName = 'chromium' | 'firefox' | 'webkit';

/** Terminal output format. `none` — the API default — writes nothing to stdout. */
export type ReporterName = 'tap' | 'spec' | 'dot' | 'github' | 'none';

/** How a single test finished. */
export type TestStatus = 'passed' | 'failed' | 'skipped' | 'todo';

/** Options shared by `run`, `watch` and `search`. */
export interface QunitxOptions {
  /**
   * Files, directories or globs to run. Accepts `file.ts#34` / `file.ts:34` line targets,
   * which narrow the run to the test (or module) declared at that line.
   * Defaults to `package.json#qunitx.inputs`.
   */
  files?: string[];
  /** Project directory; the nearest `package.json` at or above it defines the project root. */
  cwd?: string;
  /** Browser engine (default `'chromium'`). */
  browser?: BrowserName;
  /**
   * QUnit filter, matched against `"Module: test name"`. Carries QUnit's own semantics:
   * case-insensitive substring, `/regex/`, `/regex/i`, or a leading `!` to invert.
   */
  filter?: string;
  /** File extensions treated as test files (default `['js', 'ts', 'jsx', 'tsx']`). */
  extensions?: string[];
  /** HTML fixture files that wrap the compiled test bundle. */
  htmlPaths?: string[];
  /** Directory for the compiled bundle and reports (default `'tmp'`). */
  output?: string;
  /** Milliseconds to wait for the suite before timing out (default `20000`). */
  timeout?: number;
  /** TCP port for the local test server (default `1234`, auto-increments on conflict). */
  port?: number;
  /** esbuild plugins applied to the test bundle — for `.vue`, Svelte, custom resolvers. */
  plugins?: EsbuildPlugin[];
  /** Terminal output format (default `'none'` — the API stays silent unless asked). */
  reporter?: ReporterName;
  /** Forward browser console output and emit verbose diagnostics. */
  debug?: boolean;
}

/** Options for {@link run}. */
export interface RunOptions extends QunitxOptions {
  /** Stop the run after the first failing test. */
  failFast?: boolean;
  /** Run only the files that failed on the previous run, from the persistent failure cache. */
  onlyFailed?: boolean;
  /** Run only test files whose transitive imports include a file changed since this git ref. */
  changedSince?: string;
  /** Collect V8 line coverage (chromium only). */
  coverage?: boolean;
  /** Extra coverage artifacts beyond the in-memory summary: `'lcov'`, `'html'`. */
  coverageFormats?: Array<'lcov' | 'html'>;
  /** Write a JUnit XML report; `true` writes `<output>/junit.xml`, a string is a path. */
  junit?: boolean | string;
  /** Aborts the run and tears down the browser and server. */
  signal?: AbortSignal;
}

/** Options for {@link watch}. */
export interface WatchOptions extends QunitxOptions {
  /** Scope only the first run to previously-failing files; later reruns see every file. */
  onlyFailed?: boolean;
}

/** Options for {@link search}. */
// Search is a static scan of test declarations: no browser, no bundle, no execution, so it
// adds nothing to the shared options.
export type SearchOptions = QunitxOptions;

/** One assertion inside a failing test. */
export interface Assertion {
  /** `true` when the assertion held. */
  passed: boolean;
  /** `true` for assertions inside a `todo` test, which are expected to fail. */
  todo: boolean;
  /** The assertion's message, when one was given. */
  message?: string;
  /** The value the assertion actually saw. */
  actual?: unknown;
  /** The value the assertion required. */
  expected?: unknown;
  /** Stack trace, resolved back to original sources via the bundle's source map. */
  stack?: string;
}

/** The outcome of a single test. */
export interface TestResult {
  /** The test's own name, without its module path. */
  name: string;
  /** The QUnit module path containing the test, outermost first. */
  module: string[];
  /** `"Module > name"` — the module path and test name joined for display. */
  fullName: string;
  /** How the test finished. */
  status: TestStatus;
  /** Duration in milliseconds. */
  duration: number;
  /** Absolute path of the test file, resolved via source map. `null` when unattributable. */
  file: string | null;
  /** Assertions for this test. Populated for failures; empty for passing tests, which
   *  QUnit reports without an assertion payload. */
  assertions: Assertion[];
}

/** Test counts for a run. */
export interface RunCounts {
  /** Every test that reported a result. */
  total: number;
  /** Tests where every assertion passed. */
  passed: number;
  /** Tests with at least one failing assertion. */
  failed: number;
  /** Tests explicitly skipped. */
  skipped: number;
  /** Tests marked `todo` — expected to fail. */
  todo: number;
}

/** The result of a completed run. */
export interface RunResult {
  /** `true` when nothing failed — the one field most callers need. */
  ok: boolean;
  /** The exit code the CLI would have used for this run: `0` when ok, `1` otherwise. */
  exitCode: number;
  /** Counts by outcome. */
  counts: RunCounts;
  /** Wall-clock duration of the run in milliseconds. */
  duration: number;
  /** Every test that reported a result, in completion order. */
  tests: TestResult[];
  /** Just the failing tests — `tests.filter((t) => t.status === 'failed')`. */
  failures: TestResult[];
  /** Absolute paths of test files with at least one failure. */
  failedFiles: string[];
  /** Line coverage, when `coverage` was enabled. */
  coverage?: CoverageSummary;
}

/** Line-coverage totals, plus a per-file breakdown. */
export interface CoverageSummary {
  /** Executable lines across all files. */
  totalLines: number;
  /** Executable lines that ran at least once. */
  coveredLines: number;
  /** `coveredLines / totalLines` as a percentage, or `100` when there is nothing to cover. */
  percentage: number;
  /** Per-file coverage, keyed by absolute source path. */
  files: Record<string, FileCoverageSummary>;
}

/** Line coverage for one source file. */
export interface FileCoverageSummary {
  /** Executable lines in the file. */
  totalLines: number;
  /** Executable lines that ran at least once. */
  coveredLines: number;
  /** `coveredLines / totalLines` as a percentage. */
  percentage: number;
  /** 1-based line numbers that never executed. */
  uncoveredLines: number[];
}

/** A test discovered by {@link search}, from a static scan of test declarations. */
export interface DiscoveredTest {
  /** The test's own name. */
  name: string;
  /** The QUnit module path containing the test. */
  module: string[];
  /** `"Module > name"`. */
  fullName: string;
  /** Absolute path of the file declaring the test. */
  file: string;
  /** 1-based line number of the declaration. */
  line: number;
}

/** Events emitted by a {@link RunHandle}. */
export interface RunEvents {
  /** Fired once when the run begins, before any test executes. */
  runStart: [RunStartInfo];
  /** Fired as each test finishes. */
  testEnd: [TestResult];
  /** Fired once when the run completes, with the same value the handle resolves to. */
  runEnd: [RunResult];
}

/** Describes a run as it starts. */
export interface RunStartInfo {
  /** Test files in this run, or `null` when not yet known (watch mode). */
  fileCount: number | null;
  /** Concurrent groups the files were split across, or `null` alongside a null `fileCount`. */
  groupCount: number | null;
}

/** Events emitted by a {@link WatchSession}. */
export interface WatchEvents extends RunEvents {
  /** Fired when a file change triggers a rerun, with the changed paths. */
  change: [string[]];
}
