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
      // In watch+debug mode use inline so the DevTools console shows original source.
      // In watch-only mode use 'linked' so the source map is a separate file that DevTools
      // loads on demand — this keeps the inlined HTML bundle ~3x smaller and avoids a
      // multi-second JS parse under CI load that was causing WebSocket connection timeouts.
      sourcemap: config.debug ? 'inline' : config.watch ? 'linked' : false,
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
  try {
    console.log('#', blue(`QUnitX running: http://localhost:${config.port}${filePath}`));

    // Single promise driven by the WS handler:
    //   config._testRunDone()      → tests finished normally
    //   config._resetTestTimeout() → reset idle timer; fires as timeout if silent for config.timeout ms
    // This replaces waitForFunction (CDP polling), which raced against WS testEnd messages
    // under load: CDP could win and trigger cleanup before Node.js processed the pending messages.
    const testRaceResult = new Promise((resolve) => {
      config._testRunDone = () => resolve(false);
      config._resetTestTimeout = () => {
        clearTimeout(timeoutHandle);
        timeoutHandle = setTimeout(() => resolve(true), config.timeout);
      };
    });

    const targetUrl = `http://localhost:${config.port}${filePath}`;
    if (page.url() === targetUrl) {
      // Re-run in watch mode: same URL — use reload() to guarantee a full fresh navigation.
      // page.goto(same_url) can silently no-op or serve cached HTML on some Playwright/Chrome
      // versions, leaving the old WebSocket in place and causing a 20s timeout.
      await page.reload({ timeout: config.timeout + 10000 });
    } else {
      await page.goto(targetUrl, { timeout: config.timeout + 10000 });
    }

    config._resetTestTimeout(); // start idle countdown once the page is loaded

    await testRaceResult;

    QUNIT_RESULT = await page.evaluate(() => window.QUNIT_RESULT);
  } catch (error) {
    targetError = error;
    console.log(error);
    console.error(error);
  } finally {
    clearTimeout(timeoutHandle);
    config._resetTestTimeout = null;
  }

  if (!QUNIT_RESULT || QUNIT_RESULT.totalTests === 0) {
    console.log(targetError);
    console.log('BROWSER: runtime error thrown during executing tests');
    console.error('BROWSER: runtime error thrown during executing tests');
    await failOnNonWatchMode(config.watch, { server, browser }, config._groupMode);
  } else if (QUNIT_RESULT.totalTests > QUNIT_RESULT.finishedTests) {
    console.log(targetError);
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
