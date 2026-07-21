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
 * Two lifetimes share this shape: the per-process one on {@link BuildState} (watch mode)
 * and the daemon's persistent one, which survives across runs. `buildIncrementally` takes
 * either — it disposes and recreates the context whenever the key changes.
 */
export interface EsbuildCache {
  /** Live esbuild incremental context, or `null`/absent before the first build. */
  context?: BuildContext | null;
  /** Cache key for `context`: `allTestFilePaths.join('\0')`. Invalidated when files change. */
  contextKey?: string;
}

/**
 * One group's esbuild output and in-flight build bookkeeping, kept warm between watch-mode
 * rebuilds. Lives at `state.group.build`, so it shares the group's lifetime rather than being
 * threaded alongside the config as a second, independently-passable bag.
 */
export interface BuildState extends EsbuildCache {
  /** Full test bundle source, or `null` before the first build completes. */
  allTestCode: Buffer | string | null;
  /** Bundle filtered to files that failed on the previous run (used by re-run mode). */
  filteredTestCode?: Buffer | string;
  /** Absolute paths of every HTML file that will be opened in the browser to run tests. */
  htmlPathsToRunTests: string[];
  /**
   * In-flight build promise started by `run.ts` before Chrome setup completes (initial run)
   * or before `runTestsInBrowser` is called (reruns), so esbuild races navigation.
   * Consumed and cleared by the first `runTestsInBrowser()` call.
   */
  preBuildPromise?: Promise<void> | null;
  /**
   * Set when a parallel rebuild is in-flight during a watch-mode rerun. The `/tests.js`
   * route awaits this before serving, so Chrome can navigate concurrently while esbuild
   * finishes. Cleared by `runTestsInBrowser` after the build settles.
   */
  activeRebuild?: Promise<void> | null;
  /**
   * Replaces the normal test page for this run, or `null` when the run renders tests as usual.
   * The web server's `/` route serves this page and the Playwright page is navigated there.
   * Cleared at the start of every new build attempt.
   */
  fallbackPage?: FallbackPage | null;
  /**
   * `true` if the most recent build ended in an esbuild error. Keeps `state.watch.lastBuildEndMs`
   * pinned to the last good build so a fix arriving after the error is never suppressed. Written
   * by every run, read only in watch mode.
   */
  lastBuildErrored: boolean;
}

/**
 * The run's resolved HTML fixtures and the assets they reference. Populated once by
 * `buildCachedContent` and not written again, so every concurrent group can share one copy.
 */
export interface HtmlAssets {
  /** Asset paths (scripts, stylesheets) discovered inside the user's HTML fixture. */
  assets: Set<string>;
  /** The primary HTML page: its path on disk and its resolved content. */
  mainHTML: { filePath: string | null; html: string | null };
  /** Static HTML pages served verbatim, keyed by their server-relative path. */
  staticHTMLs: Record<string, string>;
  /** HTML pages whose bundle content is injected at request time, keyed by server-relative path. */
  dynamicContentHTMLs: Record<string, string>;
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
export type FallbackPage =
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
 * Mutable state for one test run, kept separate from the resolved settings on {@link Config}.
 *
 * Organized by **sharing lifetime**, and that organization is the invariant to preserve:
 *
 * - **Every field except `group` is shared by reference across all concurrent groups.** Groups are
 *   spread off the parent with a shallow `{...config}`, which copies `state` by reference. So the
 *   counter, failure sets, coverage collector and reporters are one set of objects for the whole
 *   run — which is what makes TAP numbering globally sequential and the coverage report whole.
 * - **`group` is replaced per group.** It is the only place a per-group slot may live; anything
 *   added elsewhere silently becomes shared.
 *
 * The consequence for shared fields is that they must be **mutated in place, never reassigned** —
 * see `resetRunResults`. Assigning a fresh object on one config detaches it from the others and
 * splits the run's totals, which no type can catch. Fields of a shared object may be reassigned
 * freely (`results.coverage = new Map()`); it is the object itself that must survive.
 */
export interface RunState {
  /** Whole-run accumulators, shared by reference across every concurrent group. */
  results: RunResults;
  /**
   * Active reporter instances for this run, built by `createReporters` in `setupConfig`.
   * One set for the whole run, so a stateful reporter sees every group rather than one slice.
   */
  reporters: Reporter[];
  /**
   * Non-null exactly when this run is executing inside the persistent daemon process — it is
   * the daemon-mode flag as well as the handles. Daemon runs throw `DaemonRunError` instead of
   * calling `process.exit`, suppress the per-connection TAP header, and leave the shared browser
   * open at the end of the run.
   */
  daemon: DaemonState | null;
  /** Number of concurrent groups in this run; 1 for watch and single-group runs. */
  groupCount: number;
  /** File-watcher build bookkeeping. Only meaningful in watch mode, where there is one group. */
  watch: WatchState;
  /**
   * HTML fixtures and their referenced assets, resolved once by `buildCachedContent` before any
   * group config is spread off. Frozen from that point on, so all groups share one copy.
   */
  htmlAssets: HtmlAssets;
  /**
   * State for **this** group only. The group spread replaces this object (everything else in
   * `RunState` is shared by reference), so it is the one place per-group slots may live.
   */
  group: GroupState;
}

/** The run summary the browser-side runtime publishes on `window.QUNIT_RESULT`. */
export interface QUnitResult {
  /** Tests QUnit registered for this run. */
  totalTests: number;
  /** Tests that reached `testEnd`; short of `totalTests` means the run stalled. */
  finishedTests: number;
  /** Tests with at least one failing assertion. */
  failedTests: number;
  /** Name of the test in flight, or `null` when none is running — the stall diagnostic. */
  currentTest: string | null;
}

/** State scoped to a single concurrent group — one fresh object per group of a run. */
export interface GroupState {
  /** Index within the run's group array; `0` for watch and single-group runs. */
  index: number;
  /** `true` while running as one of several concurrent groups. */
  groupMode: boolean;
  /** Callbacks the run pipeline waits on, resolved as the browser reaches each milestone. */
  signals: RunSignals;
  /** Current lifecycle phase of this group's run. */
  phase: 'bundling' | 'connecting' | 'loading' | 'running' | 'done';
  /**
   * Exact test selections for this group, derived from `lineTargets`. Applied in the browser via
   * `QUnit.config.testFilter`, which QUnit ANDs after `filter`/`module`. Per-group: each
   * line-targeted file runs as its own group so untargeted files stay unfiltered.
   */
  selectors: QUnitSelector[] | undefined;
  /**
   * Test files this group ran on the last run. Failure attribution falls back to this when a
   * failing assertion's stack can't be resolved to one file — scoped per group so an
   * unattributable failure blames only the files that group ran, not the whole invocation.
   *
   * Watch mode runs exactly one group, so this doubles as the `ql` rerun target there. Named to
   * pair with {@link lastFailedFiles}.
   */
  lastRanFiles: string[] | null;
  /** Files treated as failed for the `qf` rerun shortcut. Watch mode only, hence single-group. */
  lastFailedFiles: string[] | null;
  /**
   * Tracks `testEnd` arrivals per test fullName in this group's run. Reset in lockstep with the
   * run counter — explicitly NOT on every WS 'connection' event, which was the bug that broke
   * no-html-test in CI run 26042614416.
   *
   * The WS testEnd handler enforces "QUnit fires testEnd exactly once per registered test per
   * run" by checking this map before incrementing the counter: a second arrival of the same
   * fullName is dropped with a `# [qunitx] WARNING: duplicate testEnd ignored ...` line on
   * stderr+stdout so the underlying browser/runtime bug stays visible while pass counts stay
   * correct. Per-group because two groups can legitimately share a fullName when they bundle
   * different files registering the same module/test names — the dedup key is intra-group.
   */
  testEndCounts: Map<string, number>;
  /**
   * Diagnostic-only: how many distinct WS connections this group's wss handler has accepted.
   * Reset per `setupWebServer` call. > 1 means the browser opened multiple WebSocket connections
   * within one run — the prime suspect for the 2× test-execution flake (WS retry path in the
   * injected runtime).
   */
  wsConnectionCount: number;
  /** QUNIT_RESULT delivered via the WS 'done' message; avoids a page.evaluate() CDP round-trip. */
  lastQUnitResult: QUnitResult | null;
  /** In-flight console handler promises; awaited before browser/page close so Firefox BiDi
   * round-trips complete. */
  pendingConsoleHandlers: Set<Promise<void>> | null;
  /** Decoded inline source map for this group's bundle; resolves stack frames to original sources. */
  sourceMapDecoder: SourceMapDecoder | null;
  /** This group's bundle output and build bookkeeping. */
  build: BuildState;
}

/**
 * One-shot callbacks wiring the browser's progress back into the run pipeline. Each is installed
 * by the code that awaits it and fired by the web server as the corresponding event arrives.
 */
export interface RunSignals {
  /** Resolves when the browser signals that the test run is complete. */
  testRunDone: (() => void) | null;
  /** Resets the inactivity timeout; called on each TAP progress event. */
  resetTestTimeout: (() => void) | null;
  /** Resolves when the WebSocket connection from the browser page is established. */
  onWsOpen: (() => void) | null;
  /** Resolves when the test bundle JS has been served to the browser at least once. */
  onTestsJsServed: (() => void) | null;
}

/**
 * Build bookkeeping owned by the file watcher, used to decide whether a filesystem event
 * should dispatch a rebuild. Watch mode runs exactly one group, so nothing here is contended.
 */
export interface WatchState {
  /** `true` while esbuild is actively compiling. */
  building: boolean;
  /** Queued build-trigger callback; fires once the in-progress build completes. */
  pendingBuildTrigger: (() => void) | null;
  /** File paths added since the last build, used to decide whether a rebuild is needed. */
  justAddedFiles: Set<string>;
  /** Timestamp (ms) of the most recent *successful* build, used for debounce logic. `0` before
   * the first build. */
  lastBuildEndMs: number;
  /** Per-file content hash of what was last dispatched to a build. Both the fs.watch change
   * handler and the macOS/Deno rescan compare against this instead of mtime — mtime has
   * 1-second resolution on some filesystems (macOS/HFS+), so rapid same-second writes with
   * different content are indistinguishable by mtime; the hash catches them and drops echoes. */
  builtContentHash: Record<string, string>;
  /** `filePath → ms` of when each file was last processed as an 'add', so a 'change' echo
   * arriving inside ADD_SUPPRESS_WINDOW_MS can be suppressed. */
  justAddedAt: Map<string, number>;
}

/** The daemon's persistent, cross-run handles, lent to a single run via {@link RunState.daemon}. */
export interface DaemonState {
  /** The daemon's Browser. `run()` reuses it instead of launching, and does not close it. */
  browser: Browser;
  /** Persistent incremental-context slot, keeping the module graph warm across daemon runs. */
  esbuildCache: EsbuildCache;
  /**
   * Persistent Page slot, reused across runs to save a `newPage()` (~70-130ms). Read through
   * `reusablePageSlot()`, never directly — reuse is only valid for single-group runs.
   */
  pageSlot: { page: Page | null };
}

/**
 * Outcome totals and failure bookkeeping accumulated across every group of a single run.
 * Every field here is mutated in place — see {@link RunState} for why replacement is unsafe.
 */
export interface RunResults {
  /** Running test-outcome counts, mutated in place as TAP events arrive. */
  counter: Counter;
  /**
   * Absolute paths of test files with ≥1 failure in the current run, attributed per-test via
   * source maps. Every group adds into this one set; persisted to the failure cache at run end.
   */
  failedFiles: Set<string>;
  /** Per-test metadata for the current run's failures; accumulated alongside `failedFiles`. */
  failedTests: FailedTestRecord[];
  /**
   * Accumulator for per-source line coverage when `coverage` is enabled; `null` when it is off.
   * Reassigned only by `resetRunResults` (a fresh Map per run), never by a group.
   */
  coverage: CoverageFileMap | null;
}

/**
 * Full resolved qunitx configuration for a single run, merging `package.json` settings,
 * CLI flags, and runtime state. Most fields are read-only after `setupConfig()` resolves;
 * underscore-prefixed fields are mutable runtime slots populated during the run lifecycle.
 */
export interface Config {
  /** Mutable state for this run; see {@link RunState} for the sharing rules. */
  state: RunState;
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
  wholeInputPaths?: string[];
  /**
   * The run's HTTP server, exposed purely as `--before` / `--after` hook surface — qunitx itself
   * never reads it back. Hooks use it to register extra routes (mock APIs) before tests start.
   */
  webServer?: HTTPServer;
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
/**
 * Handles to a pre-launched Chrome, available **synchronously** the moment it is spawned —
 * before the CDP endpoint is known. Enough to reap the process and its temp dir, which is all
 * the `process.on('exit')` safety net and `shutdownPrelaunch()` need.
 */
export interface ChromeHandle {
  /** The spawned Chrome child process. */
  proc: ChildProcess;
  /** Kills Chrome and awaits async temp-dir cleanup. Safe to call before CDP is ready, and
   * idempotent with Chrome's own dead-on-arrival cleanup. Call before `process.exit()`. */
  shutdown: () => Promise<void>;
}

/** A {@link ChromeHandle} plus the CDP endpoint, resolved once Chrome is listening. */
export interface EarlyChrome extends ChromeHandle {
  /** The `ws://` URL exposed by Chrome's CDP remote debugging endpoint. */
  cdpEndpoint: string;
}
