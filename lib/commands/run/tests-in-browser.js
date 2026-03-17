import fs from 'node:fs/promises';
import kleur from 'kleur';
import esbuild from 'esbuild';
import timeCounter from '../../utils/time-counter.js';
import runUserModule from '../../utils/run-user-module.js';
import TAPDisplayFinalResult from '../../tap/display-final-result.js';

class BundleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BundleError';
    this.message = `esbuild Bundle Error: ${message}`.split('\n').join('\n# ');
  }
}

/**
 * Pre-builds the esbuild bundle for all test files and caches the result in `cachedContent`.
 * @returns {Promise<void>}
 */
export async function buildTestBundle(config, cachedContent) {
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
      sourcemap: config.debug || config.watch ? 'inline' : false,
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
 * Runs the esbuild-bundled tests inside a Puppeteer-controlled browser page and streams TAP output.
 * @returns {Promise<object>}
 */
export default async function runTestsInBrowser(
  config,
  cachedContent = {},
  connections,
  targetTestFilesToFilter,
) {
  const { projectRoot, output } = config;
  const allTestFilePaths = Object.keys(config.fsTree);
  const runHasFilter = !!targetTestFilesToFilter;

  // In group mode the COUNTER is shared across all groups and managed by run.js.
  if (!config._groupMode) {
    config.COUNTER = { testCount: 0, failCount: 0, skipCount: 0, passCount: 0 };
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

function buildFilteredTests(filteredTests, outputPath, config) {
  return esbuild.build({
    stdin: {
      contents: filteredTests.map((f) => `import "${f}";`).join(''),
      resolveDir: process.cwd(),
    },
    bundle: true,
    logLevel: 'error',
    outfile: outputPath,
    sourcemap: config.debug || config.watch ? 'inline' : false,
  });
}

async function runTestInsideHTMLFile(filePath, { page, server, browser }, config) {
  let QUNIT_RESULT;
  let targetError;
  try {
    console.log('#', kleur.blue(`QUnitX running: http://localhost:${config.port}${filePath}`));

    const testsDone = new Promise((resolve) => {
      config._testRunDone = resolve;
    });

    await page.evaluateOnNewDocument(() => {
      window.IS_PUPPETEER = true;
    });
    await page.goto(`http://localhost:${config.port}${filePath}`, {
      timeout: config.timeout + 10000,
    });
    await Promise.race([
      testsDone,
      page.waitForFunction(`window.testTimeout >= ${config.timeout}`, {
        timeout: config.timeout + 10000,
      }),
    ]);

    QUNIT_RESULT = await page.evaluate(() => window.QUNIT_RESULT);
  } catch (error) {
    targetError = error;
    console.log(error);
    console.error(error);
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
  }
}

async function failOnNonWatchMode(watchMode = false, connections = {}, groupMode = false) {
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
