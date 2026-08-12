import type { HTTPServer } from './web/index.ts';
import type { ParsedFlags } from './args/parse.ts';
import type { Browser, Page } from 'playwright-core';
import type { ChildProcess } from 'node:child_process';
import type { Buffer } from 'node:buffer';
import type { BuildContext, Plugin as EsbuildPlugin } from 'esbuild';
import type { SourceMapDecoder } from './utils/source-map.ts';
import type { Reporter } from './reporters/types.ts';
import type { Console } from './console.ts';
import type { QUnitSelector } from './selection/line-targets.ts';
import type { FailedTestRecord } from './utils/failure-cache.ts';

/**
 * Running totals of test outcomes for a single test run.
 * Mutated in place as TAP events arrive from the browser.
 *
 * ```ts
 * const counter: Counter =
 *   { total: 3, failed: 1, skipped: 0, todo: 0, passed: 2, assertionsFailed: 0 };
 * counter.total; // 3 — the sum of the pass/fail/skip/todo buckets
 * ```
 */
export interface Counter {
  /** Total number of test cases registered. */
  total: number;
  /** Number of test cases that had at least one failing assertion. */
  failed: number;
  /** Number of test cases explicitly marked as skipped (not run). */
  skipped: number;
  /** Number of test cases marked as todo (expected to fail, work in progress). */
  todo: number;
  /** Number of test cases where every assertion passed. */
  passed: number;
  /** Number of test cases that threw an unexpected error outside of assertions. */
  assertionsFailed: number;
}

/**
 * Snapshot of the project's file-system structure: a map of relative paths to `null`.
 * Diffed against a fresh snapshot in watch mode to detect added or removed test files.
 *
 * ```ts
 * const tree: FSTree = { 'test/cart-test.ts': null, 'test/user-test.ts': null };
 * 'test/cart-test.ts' in tree; // true — membership is the only question a snapshot answers
 * ```
 */
export type FSTree = Record<string, null>;

/**
 * A slot holding esbuild's incremental build context plus the key it was built for.
 * Two lifetimes share this shape: the per-process one on {@link BuildState} (watch mode)
 * and the daemon's persistent one, which survives across runs. `buildIncrementally` takes
 * either — it disposes and recreates the context whenever the key changes.
 *
 * ```ts
 * const cache: EsbuildCache = { context: null };
 * cache.contextKey = ['a-test.ts', 'b-test.ts'].join('\0');
 * cache.contextKey === ['a-test.ts'].join('\0'); // false — file set changed, context is stale
 * ```
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
 *
 * ```ts
 * const build: BuildState = { allTestCode: null, htmlPathsToRunTests: [], lastBuildErrored: false };
 * build.allTestCode; // null — nothing compiled yet, the first build fills it
 * ```
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
   * or before `run` is called (reruns), so esbuild races navigation.
   * Consumed and cleared by the first `run()` call.
   */
  preBuildPromise?: Promise<void> | null;
  /**
   * Set when a parallel rebuild is in-flight during a watch-mode rerun. The `/tests.js`
   * route awaits this before serving, so Chrome can navigate concurrently while esbuild
   * finishes. Cleared by `run` after the build settles.
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
 *
 * ```ts
 * const htmlAssets: HtmlAssets = {
 *   assets: new Set(['/app.css']),
 *   mainHTML: { filePath: null, html: null },
 *   staticHTMLs: {},
 *   dynamicContentHTMLs: {},
 * };
 * htmlAssets.assets.has('/app.css'); // true — served alongside the fixture that references it
 * ```
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

/**
 * An esbuild failure, captured for display on the run's error page.
 *
 * ```ts
 * const error: BuildError = {
 *   type: 'Build Error',
 *   formatted: '✘ [ERROR] Could not resolve "./missing.ts"',
 * };
 * error.type; // 'Build Error' — becomes the fallback page's heading
 * ```
 */
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
 *
 * ```ts
 * const fallback: FallbackPage = { kind: 'no-tests', files: ['test/empty-test.ts'] };
 * if (fallback.kind === 'no-tests') fallback.files; // `kind` narrows — ['test/empty-test.ts']
 * ```
 */
export type FallbackPage =
  { kind: 'build-error'; error: BuildError } | { kind: 'no-tests'; files: string[] };

/**
 * One collected JUnit `<testcase>` — accumulated per `testEnd` and serialized into
 * `junit.xml` at run end when `--reporter=junit` is active.
 *
 * ```ts
 * const testcase: JUnitCase = {
 *   classname: 'Cart > totals',
 *   name: 'sums line items',
 *   time: 0.012, // QUnit reported 12ms
 *   status: 'passed',
 * };
 * ```
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
 *
 * ```ts
 * const file: FileCoverage = {
 *   coverable: new Set([1, 2, 5]),
 *   covered: new Map([[1, 3]]),
 *   sourceContent: null,
 * };
 * file.covered.get(1); // 3 — line 1 was hit three times; lines 2 and 5 stayed uncovered
 * ```
 */
export interface FileCoverage {
  /** 1-based line numbers that the source map attributes to executable bundle positions. */
  coverable: Set<number>;
  /** 1-based line number → highest V8 hit count observed for that line. */
  covered: Map<number, number>;
  /** Verbatim original source text (from the map's `sourcesContent`), for the HTML report. */
  sourceContent: string | null;
}

/**
 * Absolute source path → its accumulated {@link FileCoverage}.
 *
 * ```ts
 * const coverage: CoverageFileMap = new Map();
 * coverage.set('/proj/cart.ts', { coverable: new Set([1]), covered: new Map(), sourceContent: null });
 * coverage.size; // 1
 * ```
 */
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
 * see `RunState.reset`. Assigning a fresh object on one config detaches it from the others and
 * splits the run's totals, which no type can catch. Fields of a shared object may be reassigned
 * freely (`results.coverage = new Map()`); it is the object itself that must survive.
 *
 * ```ts
 * import * as RunState from './setup/run-state.ts';
 *
 * const state = RunState.create();
 * state.results.counter.total; // 0 — one shared accumulator for the whole run
 * ```
 */
export interface RunState {
  /** Whole-run accumulators, shared by reference across every concurrent group. */
  results: RunResults;
  /**
   * Active reporter instances for this run, built by `Reporters.create` in `Config.setup`.
   * One set for the whole run, so a stateful reporter sees every group rather than one slice.
   */
  reporters: Reporter[];
  /**
   * Where this run's text goes: the TAP document, every reporter line, every `#` diagnostic and
   * every forwarded page log. `processConsole` for the CLI, `silentConsole` for a programmatic run that
   * only wants the result value. Shared by reference across concurrent groups.
   *
   * Named `console`, not `output`: `config.output` is the build DIRECTORY, and the two were one
   * word apart on the same object graph.
   */
  console: Console;
  /**
   * Cancels this run when it fires, or absent when nothing can. Carried here rather than threaded
   * alongside the config because it is per-run input like everything else in `state` — and it is
   * what lets a verb reach it from the resolved config instead of re-reading the raw arguments.
   *
   * Only carried: `Config.setup` never subscribes. Whoever wires a listener has to unwire it, and
   * setup has no teardown, so a shared controller would accumulate one listener per run.
   */
  signal?: AbortSignal;
  /**
   * Non-null exactly when this run is executing inside the persistent daemon process — it is
   * the daemon-mode flag as well as the handles. Daemon runs reuse the shared browser, suppress
   * the per-connection TAP header, and leave that browser open at the end of the run.
   */
  daemon: DaemonState | null;
  /** Number of concurrent groups in this run; 1 for watch and single-group runs. */
  groupCount: number;
  /**
   * How this run's files were split across those groups — the descriptive record `RunResult`
   * reports. Assigned once per run alongside `groupCount` and shared by reference, so a group
   * can read the whole split rather than only its own slice.
   *
   * Empty until a split is computed, which is why `groupCount` stays the authority the runner
   * branches on: page reuse is decided during daemon setup, before any grouping exists. Watch
   * never splits at all, so it leaves this empty and the result names its one group from the
   * files that rerun ran.
   */
  groups: RunGroup[];
  /**
   * One callback per live server that tells its connected pages to drop the rest of the QUnit
   * queue — what `qq`, `session.abort()` and an aborted `signal` all go through.
   *
   * A set rather than a slot because a concurrent run may have one server per group, and
   * aborting half a run is not aborting it. Shared by reference across groups, so a group
   * registering its own server marks it for everyone. Entries for closed servers are harmless:
   * publishing to a server with no clients reaches nobody.
   */
  aborters: Set<() => void>;
  /** File-watcher build bookkeeping. Only meaningful in watch mode, where there is one group. */
  watch: WatchState;
  /**
   * HTML fixtures and their referenced assets, resolved once by `buildCachedContent` before any
   * group config is spread off. Frozen from that point on, so all groups share one copy.
   */
  htmlAssets: HtmlAssets;
  /**
   * RunState for **this** group only. The group spread replaces this object (everything else in
   * `RunState` is shared by reference), so it is the one place per-group slots may live.
   */
  group: GroupState;
}

/**
 * One concurrent group of a run: the files bundled into a single page, and where that page's
 * artifacts were written.
 *
 * Which files land together is decided per run from recorded timings and the core count, so it
 * is neither stable across runs nor derivable by the caller — and it is exactly what you need to
 * reproduce a failure that only happens when two files share a bundle.
 *
 * ```ts
 * const group: RunGroup = { index: 1, files: ['/proj/test/cart.ts'], output: '/proj/tmp/group-1' };
 * group.output; // '/proj/tmp/group-1' — still on disk after the run, unlike the group's URL
 * ```
 */
export interface RunGroup {
  /** Position in the run's group list, and the `group-<index>` suffix on `output`. */
  index: number;
  /** Absolute paths of the test files this group bundled and ran together. */
  files: string[];
  /** Absolute path of this group's build output directory. */
  output: string;
}

/**
 * The run summary the browser-side runtime publishes on `window.QUNIT_RESULT`.
 *
 * ```ts
 * const result: QUnitResult =
 *   { totalTests: 8, finishedTests: 7, failedTests: 1, currentTest: 'Cart: checkout' };
 * result.finishedTests < result.totalTests; // true — the run stalled inside `currentTest`
 * ```
 */
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

/**
 * RunState scoped to a single concurrent group — one fresh object per group of a run.
 *
 * ```ts
 * import * as RunState from './setup/run-state.ts';
 *
 * const group: GroupState = RunState.newGroup(1, [{ module: 'Cart' }]);
 * group.phase; // 'bundling' — every group starts before its bundle exists
 * ```
 */
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
   * Watch mode runs exactly one group, so this doubles as the `ql` rerun target there, and the
   * `qf` fallback when the last run had no failures to scope to.
   */
  lastRanFiles: string[] | null;
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
   * Reset per `WebServer.setup` call. > 1 means the browser opened multiple WebSocket connections
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
 *
 * ```ts
 * import * as RunState from './setup/run-state.ts';
 *
 * const { signals } = RunState.newGroup();
 * signals.onWsOpen = () => {}; // installed by the code that awaits it, fired by the web server
 * ```
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
 *
 * ```ts
 * import * as RunState from './setup/run-state.ts';
 *
 * const { watch } = RunState.create();
 * watch.lastBuildEndMs; // 0 — no successful build yet, nothing to debounce against
 * ```
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

/**
 * The daemon's persistent, cross-run handles, lent to a single run via {@link RunState.daemon}.
 *
 * ```ts
 * // Defined, not invoked: only the daemon process (`qunitx daemon _serve`) owns a real one.
 * function warmHandles(handles: DaemonState) {
 *   return handles.pageSlot.page ?? handles.browser; // reuse the stashed page when there is one
 * }
 * ```
 */
export interface DaemonState {
  /** The daemon's Browser. `run()` reuses it instead of launching, and does not close it. */
  browser: Browser;
  /** Persistent incremental-context slot, keeping the module graph warm across daemon runs. */
  esbuildCache: EsbuildCache;
  /**
   * Persistent Page slot, reused across runs to save a `newPage()` (~70-130ms). Read through
   * `RunState.reusablePageSlot()`, never directly — reuse is only valid for single-group runs.
   */
  pageSlot: { page: Page | null };
}

/**
 * Outcome totals and failure bookkeeping accumulated across every group of a single run.
 * Every field here is mutated in place — see {@link RunState} for why replacement is unsafe.
 *
 * ```ts
 * import * as RunState from './setup/run-state.ts';
 *
 * const { results } = RunState.create();
 * results.counter.passed += 1; // mutate the shared object in place — never replace it
 * ```
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
   * Reassigned only by `RunState.reset` (a fresh Map per run), never by a group.
   */
  coverage: CoverageFileMap | null;
  /**
   * Whether the browser confirmed it dropped this run's remaining queue — `qq`, `session.abort()`,
   * or an aborted `signal`. Lives here rather than on the group because groups share this object
   * by reference, so one aborted group marks the whole run without any cross-group plumbing.
   *
   * Load-bearing for the result: an aborted run and a red run both end with failures and exit 1,
   * and nothing else distinguishes "I stopped it" from "it broke".
   */
  aborted: boolean;
}

/**
 * Full resolved qunitx configuration for a single run, merging `package.json` settings,
 * CLI flags, and runtime state. Most fields are read-only after `Config.setup()` resolves;
 * underscore-prefixed fields are mutable runtime slots populated during the run lifecycle.
 *
 * ```ts
 * // Defined, not invoked: a full Config is assembled by Config.setup, not by hand.
 * function testServerUrl(config: Config) {
 *   return `http://localhost:${config.port}`;
 * }
 * ```
 */
export interface Config extends ParsedFlags {
  // A Config IS the parsed flags: everything `ParsedFlags` declares is inherited, the seven
  // below are narrowed to required (their defaults have been applied), and the rest is the
  // runtime state and resolved paths a run needs.
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
  /** File extensions treated as test files (default: `['js', 'ts']`). */
  extensions: string[];
  /** Browser engine used for the test run (`'chromium'` | `'firefox'` | `'webkit'`). */
  browser: 'chromium' | 'firefox' | 'webkit';
  /** Absolute path to the project root (directory containing `package.json`). */
  projectRoot: string;
  /**
   * Working directory this run resolves against: relative inputs, bare-specifier resolution
   * inside the test bundle, and `--before`/`--after` hook paths. `process.cwd()` for the CLI;
   * the JS API's `cwd` option otherwise. Distinct from {@link projectRoot}, which is wherever
   * the nearest `package.json` sits — running from a subdirectory keeps that subdirectory's
   * `node_modules` on the resolution chain, exactly as Node itself would.
   */
  cwd: string;
  /** Absolute paths to HTML fixture files that wrap the compiled test bundle. */
  htmlPaths: string[];
  /** Paths searched when globbing for test files. */
  testFileLookupPaths: string[];
  /** Current file-system snapshot, diffed in watch mode to detect added / removed files. */
  fsTree: FSTree;
  /**
   * Custom esbuild plugins applied during the test bundle build. Loaded from
   * `qunitx.config.{ts,js,mjs}` in the project root. Common use cases: SFC formats
   * like `.vue` (`esbuild-plugin-vue-next`), Svelte (`esbuild-svelte`), or any
   * project-specific resolvers/loaders.
   */
  plugins?: EsbuildPlugin[];
  /**
   * The run's HTTP server, exposed purely as `--before` / `--after` hook surface — qunitx itself
   * never reads it back. Hooks use it to register extra routes (mock APIs) before tests start.
   */
  webServer?: HTTPServer;
}

/**
 * Live handles for the three resources allocated at the start of a test run.
 * Passed through the run pipeline and closed together on shutdown.
 *
 * ```ts
 * // Defined, not invoked: the run pipeline allocates all three together at run start.
 * async function teardown({ page, browser, server }: Connections) {
 *   await page.close();
 *   await browser.close();
 *   await server.close();
 * }
 * ```
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
 *
 * ```ts
 * // Defined, not invoked: real handles come from Chrome.spawn / the prelaunch.
 * async function reap(chrome: ChromeHandle) {
 *   await chrome.shutdown(); // safe before CDP is ready, idempotent after
 * }
 * ```
 */
export interface ChromeHandle {
  /** The spawned Chrome child process. */
  proc: ChildProcess;
  /** Kills Chrome and awaits async temp-dir cleanup. Safe to call before CDP is ready, and
   * idempotent with Chrome's own dead-on-arrival cleanup. Call before `process.exit()`. */
  shutdown: () => Promise<void>;
}

/**
 * A {@link ChromeHandle} plus the CDP endpoint, resolved once Chrome is listening.
 *
 * ```ts
 * // Defined, not invoked: resolved by the prelaunch once Chrome prints its CDP URL on stderr.
 * function connectTarget(chrome: EarlyChrome) {
 *   return chrome.cdpEndpoint; // 'ws://127.0.0.1:<port>/devtools/browser/<id>'
 * }
 * ```
 */
export interface EarlyChrome extends ChromeHandle {
  /** The `ws://` URL exposed by Chrome's CDP remote debugging endpoint. */
  cdpEndpoint: string;
}
