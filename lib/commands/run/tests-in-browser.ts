import fs from 'node:fs/promises';
import { blue } from '../../utils/color.ts';
import esbuild from 'esbuild';
import timeCounter from '../../utils/time-counter.ts';
import runUserModule from '../../utils/run-user-module.ts';
import TAPDisplayFinalResult from '../../tap/display-final-result.ts';
import type { Config, CachedContent, Connections } from '../../types.ts';
import type HTTPServer from '../../servers/http.ts';

class BundleError extends Error {
  constructor(message: unknown) {
    super(message);
    this.name = 'BundleError';
    this.message = `esbuild Bundle Error: ${message}`.split('\n').join('\n# ');
  }
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

  await Promise.all([
    esbuild.build({
      stdin: {
        contents: allTestFilePaths.map((f) => `import "${f}";`).join(''),
        resolveDir: process.cwd(),
      },
      bundle: true,
      logLevel: 'error',
      outfile: `${projectRoot}/${output}/tests.js`,
      keepNames: true,
      sourcemap: config.debug ? 'inline' : config.watch ? 'linked' : false,
      // Signal the runtime that all test modules are registered. The runtime's maybeStart()
      // waits for both this event and the WebSocket 'open' event before calling QUnit.start().
      // Dispatching from the bundle (rather than from a script onload attr) is reliable across
      // all browsers and does not require changes to user test code.
      footer: { js: 'window.dispatchEvent(new CustomEvent("qunitx:tests-ready"));' },
    }),
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

  cachedContent.allTestCode = await fs.readFile(`${projectRoot}/${output}/tests.js`);
}

/**
 * Runs the esbuild-bundled tests inside a Playwright-controlled browser page and streams TAP output.
 * @returns {Promise<object>}
 */
export default async function runTestsInBrowser(
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
    config.COUNTER = { testCount: 0, failCount: 0, skipCount: 0, passCount: 0, errorCount: 0 };
  }
  config.lastRanTestFiles = targetTestFilesToFilter || allTestFilePaths;

  try {
    // Skip bundle build if run.js already pre-built it (group mode optimization).
    if (!cachedContent.allTestCode) {
      await buildTestBundle(config, cachedContent);
    }

    // buildTestBundle bails early when fsTree is empty (spurious unlink race on overlayfs).
    // Don't navigate the browser — the pending-trigger mechanism will fire a correct rebuild.
    if (!cachedContent.allTestCode) {
      return connections;
    }

    if (runHasFilter) {
      const outputPath = `${projectRoot}/${output}/filtered-tests.js`;
      await buildFilteredTests(targetTestFilesToFilter, outputPath, config);
      cachedContent.filteredTestCode = (await fs.readFile(outputPath)).toString();
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
      TAPDisplayFinalResult(config.COUNTER, TIME_TAKEN);

      if (config.after) {
        await runUserModule(`${process.cwd()}/${config.after}`, config.COUNTER, 'after');
      }

      if (!config.watch) {
        await Promise.all([
          connections.server && connections.server.close(),
          connections.browser && connections.browser.close(),
        ]);
        return process.exit(config.COUNTER.failCount > 0 ? 1 : 0);
      }
    }
  } catch (error) {
    config.lastFailedTestFiles = config.lastRanTestFiles;
    console.log(error);
    const exception = new BundleError(error);

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
): Promise<esbuild.BuildResult> {
  return esbuild.build({
    stdin: {
      contents: filteredTests.map((f) => `import "${f}";`).join(''),
      resolveDir: process.cwd(),
    },
    bundle: true,
    logLevel: 'error',
    outfile: outputPath,
    sourcemap: config.debug ? 'inline' : config.watch ? 'linked' : false,
    footer: { js: 'window.dispatchEvent(new CustomEvent("qunitx:tests-ready"));' },
  });
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
      timeoutHandle = setTimeout(resolveTestRace, config.timeout * 3);
    };
    config._onTestsJsServed = () => {
      // tests.js was fetched by Chrome — V8 is about to start (or has started)
      // compiling it. Give Chrome a fresh 4× budget from this moment so that
      // slow V8 compilation under CI load does not race against the WS-open timer.
      // This fires after _onWsOpen (inline runtime script runs first, then async
      // tests.js is fetched), so it extends the effective budget beyond 3×.
      clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(resolveTestRace, config.timeout * 4);
    };
    config._resetTestTimeout = () => {
      wsConnected = true;
      clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(resolveTestRace, config.timeout);
    };

    const targetUrl = `http://localhost:${config.port}${filePath}`;
    const navOptions = { timeout: config.timeout + 10000, waitUntil: 'commit' as const };
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

    // Initial wait uses a 3× budget as a safety net for extreme CPU starvation (e.g. many
    // concurrent Chrome instances on a 2-core CI runner). This covers the time until the WS
    // 'wsOpen' event fires (the inline runtime script is tiny, so WS opens quickly in < 1s
    // normally). Once 'wsOpen' arrives, _onWsOpen() resets this timer to a fresh 3× budget,
    // giving tests.js a full window to compile/execute and dispatch 'qunitx:tests-ready'.
    // WS 'connection' (QUnit.begin) then resets to the tighter config.timeout per-test budget.
    clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(resolveTestRace, config.timeout * 3);

    await testRaceResult;

    QUNIT_RESULT = await page.evaluate(() => window.QUNIT_RESULT);
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
  }

  if (!QUNIT_RESULT || QUNIT_RESULT.totalTests === 0) {
    if (targetError) console.log(targetError);
    const wsReason = !wsConnected
      ? 'WebSocket connection never received — Chrome may be CPU-starved or the page failed to load'
      : 'WebSocket connected but no tests ran — QUnit may have failed to start';
    console.log(`# TIMEOUT: ${wsReason}`);
    console.log('BROWSER: runtime error thrown during executing tests');
    console.error('BROWSER: runtime error thrown during executing tests');
    await failOnNonWatchMode(config.watch, { server, browser }, config._groupMode);
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
    process.exit(1);
  }
}
