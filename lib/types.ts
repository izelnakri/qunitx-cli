import type { HTTPServer } from './servers/http.ts';
import type { Browser, Page } from 'playwright-core';
import type { ChildProcess } from 'node:child_process';
import type { Buffer } from 'node:buffer';
import type { BuildContext } from 'esbuild';

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
 * Holds esbuild bundle output and associated HTML file metadata,
 * cached between watch-mode rebuilds to avoid redundant work.
 */
export interface CachedContent {
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
  /** Live esbuild incremental context, kept warm between watch-mode rebuilds. */
  _esbuildContext?: BuildContext | null;
  /** Cache key for `_esbuildContext`: `allTestFilePaths.join('\0')`. Invalidated when files change. */
  _esbuildContextKey?: string;
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
   * Set when the last esbuild run failed (watch mode only). The web server's `/` route serves
   * an error page instead of the normal test HTML, and the Playwright page is navigated there.
   * Cleared at the start of every new build attempt.
   */
  _buildError?: { type: string; formatted: string } | null;
  /**
   * Set when all test runs completed with 0 registered QUnit tests. Contains the display paths
   * of the test files (relative to projectRoot when possible). The web server's `/` route serves
   * a warning page. Cleared at the start of every new build attempt.
   */
  _noTestsWarning?: string[] | null;
}

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
  /** Enable file-watch mode: re-run affected tests on every save. */
  watch?: boolean;
  /** Open the test output in a browser window; a string value specifies the browser binary. */
  open?: boolean | string;
  /** Print the local server URL and forward browser console output to stdout. */
  debug?: boolean;
  /** Mutable test-outcome counters updated as TAP events arrive. */
  COUNTER: Counter;
  /** Test files that failed on the previous run (drives re-run filtering). */
  lastFailedTestFiles: string[] | null;
  /** Test files executed on the previous run. */
  lastRanTestFiles: string[] | null;
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
  /** Index within the concurrent group array; set when a shared HTTP server is used. */
  _groupId?: number;
  /** Current lifecycle phase of the test run. */
  _phase?: 'bundling' | 'connecting' | 'loading' | 'running' | 'done';
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
  /** Timestamp (ms) of the most recently completed build, used for debounce logic. */
  _lastBuildEndMs?: number;
  /** In-flight console handler promises; awaited before browser/page close so Firefox BiDi round-trips complete. */
  _pendingConsoleHandlers?: Set<Promise<void>> | null;
  /** Express app instance injected during integration tests. */
  expressApp?: unknown;
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
