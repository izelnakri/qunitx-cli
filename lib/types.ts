import type { HTTPServer } from './servers/web.ts';
import type { Browser, Page } from 'playwright-core';
import type { ChildProcess } from 'node:child_process';
import type { Buffer } from 'node:buffer';
import type { BuildContext, Plugin as EsbuildPlugin } from 'esbuild';
import type { SourceMapDecoder } from './utils/source-map-decoder.ts';
import type { Reporter, ReporterName } from './reporter/types.ts';
import type { QUnitSelector } from './selection/line-targets.ts';
import type { FailedTestRecord } from './utils/failure-cache.ts';

/**
 * Running totals of test outcomes for a single test run.
 * Mutated in place as TAP events arrive from the browser.
 */
export interface Counter {
  /** Total number of test cases registered. */
  testCount: number;
  /** Number of test cases that had at least one failing assertion. */
  failCount: number;
  /** Number of test cases explicitly marked as skipped (not run). */
  skipCount: number;
  /** Number of test cases marked as todo (expected to fail, work in progress). */
  todoCount: number;
  /** Number of test cases where every assertion passed. */
  passCount: number;
  /** Number of test cases that threw an unexpected error outside of assertions. */
  errorCount: number;
}

/**
 * Snapshot of the project's file-system structure: a map of relative paths to `null`.
 * Diffed against a fresh snapshot in watch mode to detect added or removed test files.
 */
export type FSTree = Record<string, null>;

/**
 * A slot holding esbuild's incremental build context plus the key it was built for.
 * Two lifetimes share this shape: the per-process one on {@link CachedContent} (watch mode)
 * and the daemon's persistent one, which survives across runs. `buildIncrementally` takes
 * either — it disposes and recreates the context whenever the key changes.
 */
export interface EsbuildCache {
  /** Live esbuild incremental context, or `null`/absent before the first build. */
  _esbuildContext?: BuildContext | null;
  /** Cache key for `_esbuildContext`: `allTestFilePaths.join('\0')`. Invalidated when files change. */
  _esbuildContextKey?: string;
}

/**
 * Holds esbuild bundle output and associated HTML file metadata,
 * cached between watch-mode rebuilds to avoid redundant work.
 */
export interface CachedContent extends EsbuildCache {
  /** Full test bundle source, or `null` before the first build completes. */
  allTestCode: Buffer | string | null;
  /** Bundle filtered to files that failed on the previous run (used by re-run mode). */
  filteredTestCode?: Buffer | string;
  /** Asset paths (scripts, stylesheets) discovered inside the user's HTML fixture. */
  assets: Set<string>;
  /** Absolute paths of every HTML file that will be opened in the browser to run tests. */
  htmlPathsToRunTests: string[];
  /** The primary HTML page: its path on disk and its resolved content. */
  mainHTML: { filePath: string | null; html: string | null };
  /** Static HTML pages served verbatim, keyed by their server-relative path. */
  staticHTMLs: Record<string, string>;
  /** HTML pages whose bundle content is injected at request time, keyed by server-relative path. */
  dynamicContentHTMLs: Record<string, string>;
  /**
   * In-flight build promise started by `run.ts` before Chrome setup completes (initial run)
   * or before `runTestsInBrowser` is called (reruns), so esbuild races navigation.
   * Consumed and cleared by the first `runTestsInBrowser()` call.
   */
  _preBuildPromise?: Promise<void> | null;
  /**
   * Set when a parallel rebuild is in-flight during a watch-mode rerun. The `/tests.js`
   * route awaits this before serving, so Chrome can navigate concurrently while esbuild
   * finishes. Cleared by `runTestsInBrowser` after the build settles.
   */
  _activeRebuild?: Promise<void> | null;
  /**
   * Replaces the normal test page for this run, or `null` when the run renders tests as usual.
   * The web server's `/` route serves the override and the Playwright page is navigated there.
   * Cleared at the start of every new build attempt.
   */
  pageOverride?: PageOverride | null;
}

/** An esbuild failure, captured for display on the run's error page. */
export interface BuildError {
  /** Short error class used as the page heading (e.g. `'Build Error'`). */
  type: string;
  /** Pre-formatted esbuild message block. */
  formatted: string;
}

/**
 * Why a run is showing something other than its tests: the last esbuild run failed, or every
 * test file compiled but registered 0 QUnit tests (`files` holds their display paths).
 *
 * A single slot rather than two: both conditions can be live at once (a run that registers no
 * tests and then throws), and every reader has always checked the build error first — so
 * last-write-wins on one slot reproduces that precedence, with the throw overwriting the warning.
 */
export type PageOverride =
  { kind: 'build-error'; error: BuildError } | { kind: 'no-tests'; files: string[] };

/**
 * One collected JUnit `<testcase>` — accumulated per `testEnd` and serialized into
 * `junit.xml` at run end when `--reporter=junit` is active.
 */
export interface JUnitCase {
  /** Suite name: the QUnit module path (fullName minus the test name). */
  classname: string;
  /** The test-case name (the last element of QUnit's fullName). */
  name: string;
  /** Test runtime in **seconds** (QUnit reports ms; converted on record). */
  time: number;
  /** Outcome of the test case. */
  status: 'passed' | 'failed' | 'skipped' | 'todo';
  /** First failing assertion's message (failed cases only). */
  failureMessage?: string;
  /** Concatenated failing-assertion messages + resolved stacks (failed cases only). */
  failureDetail?: string;
}

/**
 * Per-source-file line coverage, accumulated across every executed bundle.
 * Keyed by absolute source path. Lines are 1-based, matching editor/lcov conventions.
 */
export interface FileCoverage {
  /** 1-based line numbers that the source map attributes to executable bundle positions. */
  coverable: Set<number>;
  /** 1-based line number → highest V8 hit count observed for that line. */
  covered: Map<number, number>;
  /** Verbatim original source text (from the map's `sourcesContent`), for the HTML report. */
  sourceContent: string | null;
}

/** Absolute source path → its accumulated {@link FileCoverage}. */
export type CoverageFileMap = Map<string, FileCoverage>;

/**
 * Full resolved qunitx configuration for a single run, merging `package.json` settings,
 * CLI flags, and runtime state. Most fields are read-only after `setupConfig()` resolves;
 * underscore-prefixed fields are mutable runtime slots populated during the run lifecycle.
 */
export interface Config {
  /** Directory where the compiled test bundle and output HTML are written (default: `'tmp'`). */
  output: string;
  /** Maximum milliseconds to wait for the full test suite before timing out (default: `20000`). */
  timeout: number;
  /** When `true`, abort the run after the first test failure (default: `false`). */
  failFast: boolean;
  /** TCP port the local test server listens on (default: `1234`, auto-increments on conflict). */
  port: number;
  /** `true` when the user passed `--port` explicitly; startup fails if that port is already taken. */
  portExplicit?: boolean;
  /** File extensions treated as test files (default: `['js', 'ts']`). */
  extensions: string[];
  /** Browser engine used for the test run (`'chromium'` | `'firefox'` | `'webkit'`). */
  browser: 'chromium' | 'firefox' | 'webkit';
  /** Absolute path to the project root (directory containing `package.json`). */
  projectRoot: string;
  /** CLI input paths (files or directories) from which test files are discovered. */
  inputs: string[];
  /** Absolute paths to HTML fixture files that wrap the compiled test bundle. */
  htmlPaths: string[];
  /** Paths searched when globbing for test files. */
  testFileLookupPaths: string[];
  /** Current file-system snapshot, diffed in watch mode to detect added / removed files. */
  fsTree: FSTree;
  /** Path to a script run before each test run; `false` disables the before-hook. */
  before?: string | false;
  /** Path to a script run after each test run; `false` disables the after-hook. */
  after?: string | false;
  /**
   * Custom esbuild plugins applied during the test bundle build. Loaded from
   * `qunitx.config.{ts,js,mjs}` in the project root. Common use cases: SFC formats
   * like `.vue` (`esbuild-plugin-vue-next`), Svelte (`esbuild-svelte`), or any
   * project-specific resolvers/loaders.
   */
  plugins?: EsbuildPlugin[];
  /**
   * The single stdout format for the run (default `'tap'`). Artifact outputs (`junit`,
   * `coverage`) are separate additive options, not values of this field.
   */
  reporter?: ReporterName;
  /**
   * Write a JUnit XML report in addition to the `reporter` stdout stream. `true` writes
   * `<output>/junit.xml`; a string is a path (resolved against `projectRoot`).
   */
  junit?: boolean | string;
  /**
   * When `true`, collect V8 line coverage of the test bundle and emit a terminal summary
   * at run end. Chromium-only; ignored (with a warning) for firefox/webkit.
   */
  coverage?: boolean;
  /**
   * Extra coverage report formats beyond the always-on terminal summary:
   * `'lcov'` writes `<output>/coverage/lcov.info`, `'html'` writes `<output>/coverage/index.html`.
   */
  coverageFormats?: string[];
  /** Enable file-watch mode: re-run affected tests on every save. */
  watch?: boolean;
  /**
   * When set, run only the test files that failed on the previous run, read from the persistent
   * `tmp/.qunitx-last-failures.json` cache. With no input targets it re-runs exactly the cached
   * files; with targets it intersects the cache with them. In watch mode only the initial run is
   * scoped to the failures — the full set stays watched, and `qa` / `qf` / `ql` switch interactively.
   */
  onlyFailed?: boolean;
  /** Open the test output in a browser window; a string value specifies the browser binary. */
  open?: boolean | string;
  /** Print the local server URL and forward browser console output to stdout. */
  debug?: boolean;
  /**
   * When set, run only test files whose transitive imports include any file
   * changed since this git ref. `--changed` is shorthand for `--since=HEAD`.
   * Falls back to running all tests on git failure or missing metafile cache.
   */
  changedSince?: string;
  /**
   * The test filter — `-t`, `--filter`, `-m` and `--module` are four spellings of this one field.
   * Matched against `"Module: test name"` and passed through to `QUnit.config.filter` verbatim, so
   * it carries QUnit's own semantics: case-insensitive substring, `/regex/`, `/regex/i` (regexes
   * are case-SENSITIVE without the flag), or a leading `!` to invert. `QUnit.config.module` is
   * deliberately unused: it is exact against the *joined* module path, so it can match neither a
   * nested module by its own name nor a prefix. `-t '/^Cart(:| >)/'` is the exact-module recipe.
   */
  filter?: string;
  /**
   * `--search` / `-s` / `--print` / `-p`: list the tests the filter matches and exit without
   * running them. A string is the expression to preview; `true` means the flag was given bare,
   * in which case `filter` supplies the expression (and listing everything when it too is unset).
   */
  search?: string | true;
  /**
   * Line targets from `file.ts#34` / `file.ts:34` inputs, keyed by absolute path. Resolved
   * against the file's test declarations into exact `_qunitSelectors` per group; the bare
   * path still goes into `inputs`, so discovery is unaffected.
   */
  lineTargets?: Record<string, number[]>;
  /**
   * Absolute paths mentioned on the command line WITHOUT a line target — i.e. whole-file requests.
   * A directory or glob already supersedes a line target it covers; this additionally catches the
   * exact-same-path case (`a.ts a.ts#34`), which `inputs` cannot because its Set collapses the two.
   */
  _wholeInputPaths?: string[];
  /**
   * Exact test selections for this run, derived from `lineTargets`. Applied in the browser via
   * `QUnit.config.testFilter`, which QUnit ANDs after `filter`/`module`. Per-group: each
   * line-targeted file runs as its own group so untargeted files stay unfiltered.
   */
  _qunitSelectors?: QUnitSelector[];
  /** Mutable test-outcome counters updated as TAP events arrive. */
  COUNTER: Counter;
  /** Test files that failed on the previous run (drives re-run filtering). */
  lastFailedTestFiles: string[] | null;
  /** Test files executed on the previous run. */
  lastRanTestFiles: string[] | null;
  /**
   * Absolute paths of test files with ≥1 failure in the current run, attributed per-test via
   * source maps. Shared by reference across group configs (like `COUNTER`) so all groups
   * accumulate into one set; reset at the start of each run. Persisted to the failure cache.
   */
  _failedTestFiles?: Set<string>;
  /** Per-test metadata for the current run's failures; shared and reset alongside `_failedTestFiles`. */
  _failedTests?: FailedTestRecord[];
  /** Resolves when the browser signals that the test run is complete. */
  _testRunDone: (() => void) | null;
  /** Resets the inactivity timeout; called on each TAP progress event. */
  _resetTestTimeout: (() => void) | null;
  /** Resolves when the WebSocket connection from the browser page is established. */
  _onWsOpen: (() => void) | null;
  /** Resolves when the test bundle JS has been served to the browser at least once. */
  _onTestsJsServed: (() => void) | null;
  /** `true` while running a grouped (multi-file) test invocation. */
  _groupMode?: boolean;
  /**
   * `true` when running inside the persistent daemon process. Disables `process.exit`
   * paths in the run pipeline (replaced with `DaemonRunError` throws), suppresses the
   * per-WS-connection TAP version 13 header, and prevents the daemon's shared browser
   * from being closed at the end of a run.
   */
  _daemonMode?: boolean;
  /**
   * The daemon's persistent Browser instance. When set, `run()` reuses it instead of
   * calling `launchBrowser()`, and skips closing it at the end of the run. The daemon
   * passes its own browser here so concurrent group runs share one warm Chrome.
   */
  _daemonBrowser?: import('playwright-core').Browser;
  /**
   * The daemon's persistent esbuild incremental-context slot. Single source of truth
   * for the warm module graph across daemon runs; replaced (dispose+recreate) when
   * `bundleCacheKey()` changes — same correctness behavior as the cache-less path.
   */
  _daemonEsbuildCache?: EsbuildCache;
  /**
   * The daemon's persistent Page slot for single-group runs. When `slot.page` is
   * set and connected, `setupBrowser` reuses it instead of `browser.newPage()`,
   * saving ~70-130ms per warm run. The cleanup hook in `run()` re-stashes the page
   * here when the run completes healthily; mid-page state is dropped by the next
   * run's `page.goto(testUrl)` (cross-document navigation destroys the old JS
   * context, killing residual scripts and the previous run's WebSocket client).
   */
  _daemonPageSlot?: { page: import('playwright-core').Page | null };
  /** Current lifecycle phase of the test run. */
  _phase?: 'bundling' | 'connecting' | 'loading' | 'running' | 'done';
  /**
   * Tracks `testEnd` arrivals per test fullName in the current run. Reset in
   * `runTestsInBrowser` (single-group) and at groupConfig construction
   * (multi-group) — explicitly NOT on every WS 'connection' event, which
   * was the bug that broke no-html-test in CI run 26042614416. Lifetime is
   * tied to COUNTER lifetime so the two stay consistent.
   *
   * The WS testEnd handler enforces "QUnit fires testEnd exactly once per
   * registered test per run" by checking this map before incrementing
   * COUNTER: a second arrival of the same fullName is dropped with a
   * `# [qunitx] WARNING: duplicate testEnd ignored ...` line on stderr+stdout
   * so the underlying browser/runtime bug stays visible while pass counts
   * stay correct. Needed because the 2× flake (CI runs 26046813154 +
   * 26077472287 on macOS-deno webkit) ships duplicate testEnd events via
   * paths we can't fully trace from outside the browser.
   */
  _testEndCounts?: Map<string, number>;
  /**
   * Diagnostic-only: counts how many distinct WS connections have been
   * accepted by the current run's wss handler. Reset on every fresh server
   * setup (per setupWebServer call). > 1 indicates the browser opened
   * multiple WebSocket connections within a single run — the prime suspect
   * for the 2× test-execution flake (WS retry path in the injected runtime).
   */
  _wsConnectionCount?: number;
  /** QUNIT_RESULT delivered via the WS 'done' message; avoids a page.evaluate() CDP round-trip. */
  _lastQUnitResult?: {
    totalTests: number;
    finishedTests: number;
    failedTests: number;
    currentTest: string | null;
  } | null;
  /** `true` while esbuild is actively compiling. */
  _building?: boolean;
  /** Queued build-trigger callback; fires once the in-progress build completes. */
  _pendingBuildTrigger?: (() => void) | null;
  /** File paths added since the last build, used to decide whether a rebuild is needed. */
  _justAddedFiles?: Set<string>;
  /** Timestamp (ms) of the most recent *successful* build, used for debounce logic. */
  _lastBuildEndMs?: number;
  /** `true` if the most recent build ended in an esbuild error. Keeps `_lastBuildEndMs`
   * pinned to the last good build so a fix arriving after the error is never suppressed. */
  _lastBuildErrored?: boolean;
  /** Per-file content hash of what was last dispatched to a build. Both the fs.watch change
   * handler and the macOS/Deno rescan compare against this instead of mtime — mtime has
   * 1-second resolution on some filesystems (macOS/HFS+), so rapid same-second writes with
   * different content are indistinguishable by mtime; the hash catches them and drops echoes. */
  _builtContentHash?: Record<string, string>;
  /** In-flight console handler promises; awaited before browser/page close so Firefox BiDi round-trips complete. */
  _pendingConsoleHandlers?: Set<Promise<void>> | null;
  /**
   * The run's HTTP server, exposed purely as `--before` / `--after` hook surface — qunitx itself
   * never reads it back. Hooks use it to register extra routes (mock APIs) before tests start.
   */
  webServer?: HTTPServer;
  /** Decoded inline source map for the active test bundle; used to resolve stack frames to original sources. */
  _sourceMapDecoder?: SourceMapDecoder | null;
  /**
   * Active reporter instances for this run, built by `createReporters` in `setupConfig`.
   * Shared by reference across all concurrent groups (same as `COUNTER`), so a stateful
   * reporter sees the whole run rather than one group's slice.
   */
  _reporters?: Reporter[];
  /**
   * Accumulator for per-source line coverage when `coverage` is enabled. Shared across all
   * concurrent groups (set once on the parent config before the group configs are spread off
   * it). `null`/absent when coverage is off.
   */
  _coverageCollector?: CoverageFileMap | null;
}

/**
 * Live handles for the three resources allocated at the start of a test run.
 * Passed through the run pipeline and closed together on shutdown.
 */
export interface Connections {
  /** The HTTP + WebSocket server that serves the test bundle and streams TAP events. */
  server: HTTPServer;
  /** The Playwright browser instance. */
  browser: Browser;
  /** The Playwright page (tab) navigated to the test URL. */
  page: Page;
}

/**
 * A Chrome process started via CDP pre-launch before `playwright-core` has loaded.
 * Stored in a module-level promise in `chrome-prelaunch.ts` and consumed by `browser.ts`.
 */
export interface EarlyChrome {
  /** The spawned Chrome child process. */
  proc: ChildProcess;
  /** The `ws://` URL exposed by Chrome's CDP remote debugging endpoint. */
  cdpEndpoint: string;
  /** Kills Chrome and awaits async temp-dir cleanup. Call before `process.exit()`. */
  shutdown: () => Promise<void>;
}
