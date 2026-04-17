import fs from 'node:fs/promises';
import path from 'node:path';
import { blue } from '../../utils/color.ts';
import { shutdownPrelaunch } from '../../utils/chrome-prelaunch.ts';
import esbuild from 'esbuild';
import { timeCounter } from '../../utils/time-counter.ts';
import { runUserModule } from '../../utils/run-user-module.ts';
import { TAPDisplayFinalResult } from '../../tap/display-final-result.ts';
import { buildErrorHTML, buildNoTestsHTML } from '../../setup/web-server.ts';
import type { Config, CachedContent, Connections } from '../../types.ts';
import type { HTTPServer } from '../../servers/http.ts';

class BundleError extends Error {
  constructor(message: unknown) {
    super(message);
    this.name = 'BundleError';
    this.message = `esbuild Bundle Error: ${message}`.split('\n').join('\n# ');
  }
}

// esbuild BuildFailure carries a structured errors array; mirror the shape we actually read.
interface EsbuildMessage {
  text: string;
  location: { file: string; line: number; column: number; length: number; lineText: string } | null;
  notes: Array<{ text: string }>;
}

/**
 * Derives a human-readable error category from an esbuild BuildFailure or a generic Error.
 * Inspects the first structured esbuild message when available; falls back to string heuristics.
 */
export function deriveBuildErrorType(error: unknown): string {
  const msgs: EsbuildMessage[] = (error as { errors?: EsbuildMessage[] })?.errors ?? [];
  const text = msgs[0]?.text ?? (error instanceof Error ? error.message : String(error));
  if (/could not resolve|cannot find module|no such file/i.test(text))
    return 'Module Resolution Error';
  if (/unexpected token|expected .* but found|unterminated/i.test(text)) return 'Syntax Error';
  if (/is not (defined|a function)|cannot read prop/i.test(text)) return 'Reference Error';
  return 'Build Error';
}

/**
 * Formats esbuild BuildFailure messages into clean human-readable text (no ANSI codes).
 * When given a structured BuildFailure, each error is formatted with its file location and
 * a caret line. Falls back to stripping ANSI codes from the error's string representation.
 */
export function formatBuildErrors(error: unknown): string {
  const msgs: EsbuildMessage[] = (error as { errors?: EsbuildMessage[] })?.errors ?? [];
  if (msgs.length > 0) {
    return msgs
      .map((msg, i) => {
        const loc = msg.location;
        const lineNum = loc ? String(loc.line) : '';
        const pad = loc ? ' '.repeat(lineNum.length) : '';
        const locationLines = loc
          ? [
              `    ${loc.file}:${loc.line}:${loc.column}`,
              `  ${lineNum} │ ${loc.lineText}`,
              `  ${pad} │ ${' '.repeat(loc.column)}${'~'.repeat(Math.max(1, loc.length))}`,
            ]
          : [];
        const noteLines = msg.notes.filter((n) => n.text).map((n) => `    Note: ${n.text}`);
        return [`[${i + 1}] ${msg.text}`].concat(locationLines, noteLines).join('\n');
      })
      .join('\n\n');
  }
  // Fallback for non-esbuild errors: strip ANSI escape codes.
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // deno-lint-ignore no-control-regex
  return raw.replace(/\x1b\[[0-9;]*[mGKH]/g, '').replace(/\r\n/g, '\n');
}

/**
 * Pre-builds the esbuild bundle for all test files and caches the result in `cachedContent`.
 * @returns {Promise<void>}
 */
export async function buildTestBundle(config: Config, cachedContent: CachedContent): Promise<void> {
  const { projectRoot, output } = config;
  const allTestFilePaths = Object.keys(config.fsTree);

  // Defensive guard: if fsTree is empty (e.g. due to a spurious unlink from an overlayfs
  // copy-on-write race on CI), skip the build rather than writing a useless ~110-byte bundle
  // with no test modules. The pending-trigger mechanism will fire a correct rebuild once
  // the IN_CREATE event re-adds the file to fsTree.
  if (allTestFilePaths.length === 0) {
    console.log('# [buildTestBundle] fsTree is empty — skipping build (no test files found)');
    return;
  }

  const outfile = `${projectRoot}/${output}/tests.js`;
  await fs.mkdir(`${projectRoot}/${output}`, { recursive: true });
  const sourcemap: esbuild.BuildOptions['sourcemap'] = config.debug
    ? 'inline'
    : config.watch
      ? 'linked'
      : false;
  // tests.js is always written to disk: it is a useful build artifact, --open serves it
  // as a static file, and linked sourcemaps require a companion .js.map on disk.
  // The bundle is captured in memory from write:false so we never need a redundant readFile.
  const needsDisk = true;

  const buildOptions: esbuild.BuildOptions = {
    stdin: {
      contents: allTestFilePaths.map((filePath) => `import "${filePath}";`).join(''),
      resolveDir: process.cwd(),
    },
    // Allow test files outside the project root (e.g. /tmp/my-test.ts) to import
    // packages from any node_modules on the ancestor chain of cwd — the same lookup
    // order Node itself uses when resolving require() from process.cwd().
    nodePaths: ancestorNodeModules(process.cwd()),
    bundle: true,
    logLevel: 'silent',
    outfile,
    keepNames: true,
    legalComments: 'none',
    target: esbuildTarget(config.browser),
    sourcemap,
    // Signal the runtime that all test modules are registered. The runtime's maybeStart()
    // waits for both this event and the WebSocket 'open' event before calling QUnit.start().
    // Dispatching from the bundle (rather than from a script onload attr) is reliable across
    // all browsers and does not require changes to user test code.
    footer: { js: 'window.dispatchEvent(new CustomEvent("qunitx:tests-ready"));' },
  };

  cachedContent._buildError = null;
  cachedContent._noTestsWarning = null;

  try {
    const [allTestCode] = await Promise.all([
      config.watch
        ? buildIncrementally(buildOptions, allTestFilePaths.join('\0'), cachedContent, needsDisk)
        : buildWithOverlayfsRetry(buildOptions, needsDisk),
      Promise.all(
        cachedContent.htmlPathsToRunTests.map(async (htmlPath) => {
          const targetPath = `${config.projectRoot}/${config.output}${htmlPath}`;
          if (htmlPath !== '/') {
            await fs.rm(targetPath, { force: true, recursive: true });
            await fs.mkdir(targetPath.split('/').slice(0, -1).join('/'), { recursive: true });
          }
        }),
      ),
    ]);
    cachedContent.allTestCode = allTestCode;
  } catch (error) {
    cachedContent._buildError = {
      type: deriveBuildErrorType(error),
      formatted: formatBuildErrors(error),
    };
    // Always write index.html immediately: in non-watch mode the server route for '/' is only
    // reached on success (build errors in the group setup bypass runTestsInBrowser entirely),
    // and in watch mode the Playwright page is headless so it never navigates to trigger the
    // route — the --open user browser reloads via WebSocket 'refresh' and does it instead,
    // but that's async and user-dependent. Writing here guarantees the file is always current.
    await fs.writeFile(
      `${projectRoot}/${output}/index.html`,
      buildErrorHTML(cachedContent._buildError),
    );
    throw error;
  }
}

/**
 * Runs the esbuild-bundled tests inside a Playwright-controlled browser page and streams TAP output.
 * @returns {Promise<object>}
 */
export async function runTestsInBrowser(
  config: Config,
  cachedContent: CachedContent = {} as CachedContent,
  connections: Connections,
  targetTestFilesToFilter?: string[],
): Promise<Connections | undefined> {
  const { projectRoot, output } = config;
  const allTestFilePaths = Object.keys(config.fsTree);
  const runHasFilter = !!targetTestFilesToFilter;

  // In group mode the COUNTER is shared across all groups and managed by run.js.
  if (!config._groupMode) {
    config.COUNTER = {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    };
  }
  config.lastRanTestFiles = targetTestFilesToFilter || allTestFilePaths;

  try {
    // In watch mode, run.js fires buildTestBundle before setupBrowser completes and stores
    // the promise on _preBuildPromise so esbuild races Chrome setup. Always clear it here so
    // watch-mode re-runs always call buildTestBundle fresh — if we skip the await below (because
    // allTestCode is already set from a race win by esbuild), a stale resolved promise would
    // otherwise be consumed by the next re-run instead of triggering a real rebuild.
    const preBuildPromise = cachedContent._preBuildPromise;
    cachedContent._preBuildPromise = null;
    if (!cachedContent.allTestCode) {
      await (preBuildPromise ?? buildTestBundle(config, cachedContent));
    }

    // buildTestBundle bails early when fsTree is empty (spurious unlink race on overlayfs).
    // Don't navigate the browser — the pending-trigger mechanism will fire a correct rebuild.
    if (!cachedContent.allTestCode) {
      return connections;
    }

    if (runHasFilter) {
      const outputPath = `${projectRoot}/${output}/filtered-tests.js`;
      cachedContent.filteredTestCode = await buildFilteredTests(
        targetTestFilesToFilter,
        outputPath,
        config,
      );
    }

    const TIME_COUNTER = timeCounter();

    if (runHasFilter) {
      await runTestInsideHTMLFile('/qunitx.html', connections, config);
    } else {
      await Promise.all(
        cachedContent.htmlPathsToRunTests.map((htmlPath) =>
          runTestInsideHTMLFile(htmlPath, connections, config),
        ),
      );
    }

    const TIME_TAKEN = TIME_COUNTER.stop();

    // In group mode the parent orchestrator handles the final summary, after hook, and exit.
    if (!config._groupMode) {
      if (config.COUNTER.testCount === 0 && !cachedContent._buildError) {
        const displayFiles = allTestFilePaths.map((f) =>
          f.startsWith(`${projectRoot}/`) ? f.slice(projectRoot.length + 1) : f,
        );
        cachedContent._noTestsWarning = displayFiles;
        const fileWord = allTestFilePaths.length === 1 ? 'file' : 'files';
        console.log(
          `# Warning: 0 tests registered — no QUnit test cases found in ${allTestFilePaths.length} ${fileWord}`,
        );
        fs.writeFile(`${projectRoot}/${output}/index.html`, buildNoTestsHTML(displayFiles)).catch(
          () => {},
        );
      }

      TAPDisplayFinalResult(config.COUNTER, TIME_TAKEN);

      if (config.after) {
        await runUserModule(`${process.cwd()}/${config.after}`, config.COUNTER, 'after');
      }

      if (!config.watch) {
        await Promise.all([
          connections.server && connections.server.close(),
          connections.browser && connections.browser.close(),
        ]);
        await shutdownPrelaunch();
        return process.exit(config.COUNTER.failCount > 0 ? 1 : 0);
      }
    }
  } catch (error) {
    config.lastFailedTestFiles = config.lastRanTestFiles;
    const exception = new BundleError(error);

    // buildTestBundle's own catch sets _buildError for full-bundle failures before rethrowing.
    // Set it here as a fallback for buildFilteredTests failures, which arrive after
    // buildTestBundle already cleared _buildError on success. Only apply for esbuild errors
    // (those carry .errors[]) — navigation/timeout errors from runTestInsideHTMLFile should
    // not be classified as build errors.
    if (!cachedContent._buildError && (error as { errors?: unknown[] }).errors?.length) {
      cachedContent._buildError = {
        type: deriveBuildErrorType(error),
        formatted: formatBuildErrors(error),
      };
      fs.writeFile(
        `${projectRoot}/${output}/qunitx.html`,
        buildErrorHTML(cachedContent._buildError),
      ).catch(() => {});
    }

    if (config.watch) {
      console.log(`# ${exception}`);
    } else {
      throw exception;
    }
  }

  return connections;
}

function buildFilteredTests(
  filteredTests: string[],
  outputPath: string,
  config: Config,
): Promise<Buffer> {
  const sourcemap: esbuild.BuildOptions['sourcemap'] = config.debug
    ? 'inline'
    : config.watch
      ? 'linked'
      : false;
  const needsDisk = sourcemap === 'linked' || Boolean(config.open);
  return buildWithOverlayfsRetry(
    {
      stdin: {
        contents: filteredTests.map((filePath) => `import "${filePath}";`).join(''),
        resolveDir: process.cwd(),
      },
      nodePaths: ancestorNodeModules(process.cwd()),
      bundle: true,
      logLevel: 'silent',
      outfile: outputPath,
      legalComments: 'none',
      target: esbuildTarget(config.browser),
      sourcemap,
      footer: { js: 'window.dispatchEvent(new CustomEvent("qunitx:tests-ready"));' },
    },
    needsDisk,
  );
}

// On Docker/overlayfs CI, a newly written file may be visible to inotify (IN_CREATE fires)
// but its content hasn't propagated to the upper layer yet. esbuild reads 0 bytes and emits
// a footer-only IIFE (~110-150 bytes) instead of the real bundle. Any genuine test bundle
// includes QUnit via qunitx (~270 KB), so < 500 bytes always means an empty-input artifact.
// Retry up to MAX_RETRIES times (300 ms total) to give overlayfs time to flush the content.
//
// Always builds with write:false so the bundle is available in memory immediately — no extra
// fs.readFile round-trip. When needsDisk is true (linked sourcemap or --open static serving),
// all output files (js + map) are written to disk after the in-memory check passes.
async function runWithOverlayfsRetry(
  getContents: () => Promise<{ result: esbuild.BuildResult; js: Buffer }>,
  needsDisk: boolean,
): Promise<Buffer> {
  const RETRY_DELAY_MS = 100;
  const MAX_RETRIES = 3;
  const EMPTY_BUNDLE_THRESHOLD = 500;

  let { result, js } = await getContents();
  const initialSize = js.length;

  for (let retry = 1; retry <= MAX_RETRIES; retry++) {
    if (js.length >= EMPTY_BUNDLE_THRESHOLD) break;
    await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    ({ result, js } = await getContents());
  }

  // Only warn when the bundle stayed below the threshold after all retries AND grew at
  // least once — a genuine overlayfs flush race that resolved partially but not fully.
  // If the size never moved from the initial value, the file is just legitimately small
  // (no QUnit imports, tree-shaken to the footer only) and no warning is needed.
  if (js.length < EMPTY_BUNDLE_THRESHOLD && js.length !== initialSize) {
    console.log(
      `# [buildWithOverlayfsRetry] bundle is ${js.length} bytes after ${MAX_RETRIES} retries — proceeding`,
    );
  }

  if (needsDisk) {
    await Promise.all(
      result.outputFiles!.map((outputFile) => fs.writeFile(outputFile.path, outputFile.contents)),
    );
  }

  return js;
}

function buildWithOverlayfsRetry(
  options: esbuild.BuildOptions,
  needsDisk: boolean,
): Promise<Buffer> {
  const buildOpts: esbuild.BuildOptions = { ...options, write: false };
  return runWithOverlayfsRetry(async () => {
    const result = await esbuild.build(buildOpts);
    const jsFile = result.outputFiles!.find((f) => !f.path.endsWith('.map'))!;
    return { result, js: Buffer.from(jsFile.contents) };
  }, needsDisk);
}

// Uses an esbuild incremental context so the module graph stays warm between watch-mode
// rebuilds. context.rebuild() re-reads changed files but skips re-parsing unchanged
// modules, shaving ~80% off rebuild time vs a fresh esbuild.build() call.
// The context is invalidated (disposed + replaced) whenever the set of test files changes
// (file added or removed in watch mode), since the entry-point stdin content changes.
async function buildIncrementally(
  options: esbuild.BuildOptions,
  fileKey: string,
  cachedContent: CachedContent,
  needsDisk: boolean,
): Promise<Buffer> {
  const buildOpts: esbuild.BuildOptions = { ...options, write: false };

  if (!cachedContent._esbuildContext || cachedContent._esbuildContextKey !== fileKey) {
    cachedContent._esbuildContext?.dispose().catch(() => {});
    cachedContent._esbuildContext = await esbuild.context(buildOpts);
    cachedContent._esbuildContextKey = fileKey;
  }

  const ctx = cachedContent._esbuildContext;
  return runWithOverlayfsRetry(async () => {
    const result = await ctx.rebuild();
    const jsFile = result.outputFiles!.find((f) => !f.path.endsWith('.map'))!;
    return { result, js: Buffer.from(jsFile.contents) };
  }, needsDisk);
}

/**
 * Returns the esbuild target matching the browser engine in use.
 * Keeps output syntax modern (no unnecessary transpilation) while staying within what
 * each engine actually supports. Affects only output syntax — users can write any
 * modern TS/JS syntax in their test files regardless of this setting.
 */
function esbuildTarget(browser?: string): string[] {
  if (browser === 'firefox') return ['firefox115']; // Firefox ESR
  if (browser === 'webkit') return ['safari16'];
  return ['chrome120']; // default chromium; any system running qunitx has at least Chrome 120
}

async function runTestInsideHTMLFile(
  filePath: string,
  { page, server, browser }: Connections,
  config: Config,
): Promise<void> {
  let QUNIT_RESULT;
  let targetError;
  let timeoutHandle;
  // wsConnected is set by config._onWsOpen when Chrome's WS socket opens (< 1s after navigation,
  // before test bundle compilation finishes). Distinguishes "WS never opened" from "WS opened
  // but tests.js compiled too slowly" — both appear as TIMEOUT but have different root causes.
  let wsConnected = false;
  try {
    console.log('#', blue(`QUnitX running: http://localhost:${config.port}${filePath}`));

    // Single promise driven by the WS handler:
    //   config._testRunDone()      → tests finished normally
    //   config._resetTestTimeout() → reset idle timer; fires as timeout if silent for config.timeout ms
    // This replaces waitForFunction (CDP polling), which raced against WS testEnd messages
    // under load: CDP could win and trigger cleanup before Node.js processed the pending messages.
    //
    // resolveTestRace is extracted from the Promise constructor (synchronous) so we can fire
    // the initial timer directly — its budget is 3× config.timeout as a safety net for extreme
    // CPU starvation. In normal runs Chrome's WS 'open' fires in < 1s (tests.js compiles in
    // a background thread), so this budget is almost never fully consumed. Once 'connection'
    // (QUnit.begin) arrives, _resetTestTimeout() switches to the tighter per-test budget.
    // navMs is the budget Playwright gets to commit the navigation. Startup race timers must
    // never expire before navigation can complete — they are floored at navMs so that small
    // per-test timeouts (e.g. --timeout=500 for testing the timeout feature) don't starve
    // Chrome's launch sequence, which is a platform characteristic unrelated to test duration.
    const navMs = config.timeout + 10_000;
    const startupMs = Math.max(config.timeout * 3, navMs);
    const testsJsMs = Math.max(config.timeout * 4, navMs);

    let resolveTestRace!: () => void;
    const testRaceResult = new Promise<void>((resolve) => {
      resolveTestRace = resolve;
    });
    config._testRunDone = resolveTestRace;
    config._onWsOpen = () => {
      wsConnected = true;
      // WS open means Chrome is alive and executing scripts. Reset the timer
      // so tests.js gets a full fresh budget to compile/execute and dispatch
      // 'qunitx:tests-ready' — decoupled from however long the WS handshake took.
      // This is critical for watch re-runs under CI load: by the time a re-run
      // starts, other Chrome instances are competing for V8 time, and tests.js
      // compilation can easily consume the remaining initial 3× budget after WS
      // connects (observed: WS at t≈5s but tests-ready never fired within 60s).
      clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(resolveTestRace, startupMs);
    };
    config._onTestsJsServed = () => {
      // tests.js was fetched by Chrome — V8 is about to start (or has started)
      // compiling it. Give Chrome a fresh 4× budget from this moment so that
      // slow V8 compilation under CI load does not race against the WS-open timer.
      // This fires after _onWsOpen (inline runtime script runs first, then async
      // tests.js is fetched), so it extends the effective budget beyond 3×.
      clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(resolveTestRace, testsJsMs);
    };
    config._resetTestTimeout = () => {
      wsConnected = true;
      clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(resolveTestRace, config.timeout);
    };

    const targetUrl = `http://localhost:${config.port}${filePath}`;
    const navOptions = { timeout: navMs, waitUntil: 'commit' as const };
    // Use 'commit' (navigation committed, HTTP response started) rather than 'domcontentloaded'.
    // The test bundle (tests.js) is an external async script — it does NOT block DOMContentLoaded.
    // However, 'commit' is still preferred over 'domcontentloaded' because Chrome's render thread
    // can be CPU-starved on a loaded CI runner; even parsing the tiny inline runtime script and
    // firing DOMContentLoaded can stall for several seconds when many Chrome instances compete for
    // cores. 'commit' returns as soon as the server has started sending the HTTP response headers,
    // independent of Chrome's render-thread CPU time. The WS 'wsOpen' event then provides the
    // real signal that Chrome is executing scripts (triggering a timer reset via _onWsOpen).
    //
    // page.goto(same_url) can silently trigger a same-document navigation shortcut in Chrome —
    // not a true reload, so old scripts and the WebSocket from the previous run remain alive.
    // page.reload() forces a real reload when already on the right page.
    if (page.url().split('?')[0] === targetUrl) {
      await page.reload(navOptions);
    } else {
      await page.goto(targetUrl, navOptions);
    }

    // Initial wait uses startupMs (≥ 15s) as a safety net for extreme CPU starvation (e.g. many
    // concurrent Chrome instances on a 2-core CI runner). This covers the time until the WS
    // 'wsOpen' event fires (the inline runtime script is tiny, so WS opens quickly in < 1s
    // normally). Once 'wsOpen' arrives, _onWsOpen() resets this timer to a fresh startupMs budget,
    // giving tests.js a full window to compile/execute and dispatch 'qunitx:tests-ready'.
    // WS 'connection' (QUnit.begin) then resets to the tighter config.timeout per-test budget.
    clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(resolveTestRace, startupMs);

    await testRaceResult;

    // Prefer the QUNIT_RESULT piggy-backed on the WS 'done' message — zero extra latency.
    // Fall back to page.evaluate() only when the run timed out without a WS 'done' arriving
    // (config._lastQUnitResult is null), so we still get partial results for diagnostics.
    QUNIT_RESULT = config._lastQUnitResult ?? (await page.evaluate(() => window.QUNIT_RESULT));
  } catch (error) {
    targetError = error;
    console.log(error);
    console.error(error);
  } finally {
    clearTimeout(timeoutHandle);
    config._onWsOpen = null;
    config._onTestsJsServed = null;
    config._resetTestTimeout = null;
    config._testRunDone = null;
    config._lastQUnitResult = null;
  }

  if (!QUNIT_RESULT) {
    if (targetError) console.log(targetError);
    const wsReason = !wsConnected
      ? 'WebSocket connection never received — Chrome may be CPU-starved or the page failed to load'
      : 'WebSocket connected but no tests ran — QUnit may have failed to start';
    console.log(`# TIMEOUT: ${wsReason}`);
    console.log('BROWSER: runtime error thrown during executing tests');
    console.error('BROWSER: runtime error thrown during executing tests');
    await failOnNonWatchMode(config.watch, { server, browser }, config._groupMode);
  } else if (QUNIT_RESULT.totalTests === 0) {
    // QUnit ran but no tests were registered (or QUnit was not present in the bundle).
    // This is not a failure — handled at the runTestsInBrowser level as a warning.
    return;
  } else if (QUNIT_RESULT.totalTests > QUNIT_RESULT.finishedTests) {
    if (targetError) console.log(targetError);
    console.log(
      `# TIMEOUT: test stalled after ${QUNIT_RESULT.finishedTests}/${QUNIT_RESULT.totalTests} finished — last active: ${QUNIT_RESULT.currentTest}`,
    );
    console.log(`BROWSER: TEST TIMED OUT: ${QUNIT_RESULT.currentTest}`);
    console.error(`BROWSER: TEST TIMED OUT: ${QUNIT_RESULT.currentTest}`);
    await failOnNonWatchMode(config.watch, { server, browser }, config._groupMode);
  } else if (QUNIT_RESULT.failedTests > config.COUNTER.failCount) {
    // Safety net: browser tracked failures that WebSocket events never delivered to Node.js
    // (e.g. WS connection dropped mid-run). Reconcile so the exit code is always correct.
    config.COUNTER.failCount = QUNIT_RESULT.failedTests;
  }
}

async function failOnNonWatchMode(
  watchMode: boolean = false,
  connections: { server?: HTTPServer; browser?: { close(): Promise<void> } } = {},
  groupMode: boolean = false,
): Promise<void> {
  if (!watchMode) {
    if (groupMode) {
      // Parent orchestrator handles cleanup and exit; signal failure via throw.
      throw new Error('Browser test run failed');
    }
    await Promise.all([
      connections.server && connections.server.close(),
      connections.browser && connections.browser.close(),
    ]);
    await shutdownPrelaunch();
    process.exit(1);
  }
}

/**
 * Returns all node_modules directories on the ancestor chain of `dir`,
 * nearest-first — matching Node's own require() resolution algorithm.
 * Used as esbuild's `nodePaths` so test files outside the project root can still
 * import packages installed anywhere up the tree (e.g. qunitx in the project root).
 */
const ancestorNodeModules = (dir: string): string[] =>
  dir
    .split(path.sep)
    .map((_, i, parts) =>
      path.join(parts.slice(0, parts.length - i).join(path.sep) || path.sep, 'node_modules'),
    );

export { runTestsInBrowser as default };
