import fs from 'node:fs/promises';
import { normalize } from 'node:path';
import { availableParallelism } from 'node:os';
import Puppeteer from 'puppeteer';
import { blue, yellow } from '../utils/color.js';
import runTestsInBrowser, { buildTestBundle } from './run/tests-in-browser.js';
import setupBrowser from '../setup/browser.js';
import fileWatcher from '../setup/file-watcher.js';
import findInternalAssetsFromHTML from '../utils/find-internal-assets-from-html.js';
import runUserModule from '../utils/run-user-module.js';
import setupKeyboardEvents from '../setup/keyboard-events.js';
import writeOutputStaticFiles from '../setup/write-output-static-files.js';
import timeCounter from '../utils/time-counter.js';
import TAPDisplayFinalResult from '../tap/display-final-result.js';
import findChrome from '../utils/find-chrome.js';
import readBoilerplate from '../utils/read-boilerplate.js';

/**
 * Runs qunitx tests in headless Chrome, either in watch mode or concurrent batch mode.
 * @returns {Promise<void>}
 */
export default async function run(config) {
  const cachedContent = await buildCachedContent(config, config.htmlPaths);

  if (config.watch) {
    // WATCH MODE: single browser, all test files bundled together.
    // The HTTP server stays alive so the user can browse http://localhost:PORT
    // and see all tests running in a single QUnit view.
    const [connections] = await Promise.all([
      setupBrowser(config, cachedContent),
      writeOutputStaticFiles(config, cachedContent),
    ]);
    config.expressApp = connections.server;
    setupKeyboardEvents(config, cachedContent, connections);

    if (config.before) {
      await runUserModule(`${process.cwd()}/${config.before}`, config, 'before');
    }

    try {
      await runTestsInBrowser(config, cachedContent, connections);
    } catch (error) {
      await Promise.all([
        connections.server && connections.server.close(),
        connections.browser && connections.browser.close(),
      ]);
      throw error;
    }

    logWatcherAndKeyboardShortcutInfo(config, connections.server);

    await fileWatcher(
      config.testFileLookupPaths,
      config,
      async (event, file) => {
        if (event === 'addDir') return;
        if (['unlink', 'unlinkDir'].includes(event)) {
          return await runTestsInBrowser(config, cachedContent, connections);
        }
        await runTestsInBrowser(config, cachedContent, connections, [file]);
      },
      (_path, _event) => connections.server.publish('refresh', 'refresh'),
    );
  } else {
    // CONCURRENT MODE: split test files across N groups = availableParallelism().
    // All group bundles are built while Chrome is starting up, so esbuild time
    // is hidden behind the ~1.2s Chrome launch. Each group then gets its own
    // HTTP server and Puppeteer page inside one shared browser instance.
    const allFiles = Object.keys(config.fsTree);
    const groupCount = Math.min(allFiles.length, availableParallelism());
    const groups = splitIntoGroups(allFiles, groupCount);

    // Shared COUNTER so TAP test numbers are globally sequential across all groups.
    config.COUNTER = { testCount: 0, failCount: 0, skipCount: 0, passCount: 0, errorCount: 0 };
    config.lastRanTestFiles = allFiles;

    const groupConfigs = groups.map((groupFiles, i) => ({
      ...config,
      fsTree: Object.fromEntries(groupFiles.map((f) => [f, config.fsTree[f]])),
      // Single group keeps the root output dir for backward-compatible file paths.
      output: groupCount === 1 ? config.output : `${config.output}/group-${i}`,
      _groupMode: true,
    }));
    const groupCachedContents = groups.map(() => ({ ...cachedContent }));

    // Build all group bundles and write static files while Chrome is starting up.
    const [browser] = await Promise.all([
      findChrome().then((chromePath) =>
        Puppeteer.launch({
          args: [
            '--no-sandbox',
            '--disable-gpu',
            '--remote-debugging-port=0',
            '--window-size=1440,900',
            '--disable-extensions',
            '--disable-sync',
            '--no-first-run',
            '--disable-default-apps',
            '--mute-audio',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-dev-shm-usage',
            '--disable-translate',
            '--metrics-recording-only',
            '--disable-hang-monitor',
          ],
          executablePath: chromePath,
          headless: true,
        }),
      ),
      Promise.all(
        groupConfigs.map((groupConfig, i) =>
          Promise.all([
            buildTestBundle(groupConfig, groupCachedContents[i]),
            writeOutputStaticFiles(groupConfig, groupCachedContents[i]),
          ]),
        ),
      ),
    ]);

    console.log('TAP version 13');
    const TIME_COUNTER = timeCounter();
    let hasFatalError = false;

    await Promise.allSettled(
      groupConfigs.map(async (groupConfig, i) => {
        const connections = await setupBrowser(groupConfig, groupCachedContents[i], browser);
        groupConfig.expressApp = connections.server;

        if (config.before) {
          await runUserModule(`${process.cwd()}/${config.before}`, groupConfig, 'before');
        }

        try {
          await runTestsInBrowser(groupConfig, groupCachedContents[i], connections);
        } catch {
          hasFatalError = true;
        } finally {
          await Promise.all([
            connections.server && connections.server.close(),
            connections.page && connections.page.close(),
          ]);
        }
      }),
    );

    await browser.close();

    TAPDisplayFinalResult(config.COUNTER, TIME_COUNTER.stop());

    if (config.after) {
      await runUserModule(`${process.cwd()}/${config.after}`, config.COUNTER, 'after');
    }

    process.exit(config.COUNTER.failCount > 0 || hasFatalError ? 1 : 0);
  }
}

async function buildCachedContent(config, htmlPaths) {
  const htmlBuffers = await Promise.all(config.htmlPaths.map((htmlPath) => fs.readFile(htmlPath)));
  const cachedContent = htmlPaths.reduce(
    (result, _htmlPath, index) => {
      const filePath = config.htmlPaths[index];
      const html = htmlBuffers[index].toString();

      if (html.includes('{{content}}')) {
        result.dynamicContentHTMLs[filePath] = html;
        result.htmlPathsToRunTests.push(filePath.replace(config.projectRoot, ''));
      } else {
        console.log(
          '#',
          yellow(
            `WARNING: Static html file with no {{content}} detected. Therefore ignoring ${filePath}`,
          ),
        );
        result.staticHTMLs[filePath] = html;
      }

      findInternalAssetsFromHTML(html).forEach((key) => {
        result.assets.add(normalizeInternalAssetPathFromHTML(config.projectRoot, key, filePath));
      });

      return result;
    },
    {
      allTestCode: null,
      assets: new Set(),
      htmlPathsToRunTests: [],
      mainHTML: { filePath: null, html: null },
      staticHTMLs: {},
      dynamicContentHTMLs: {},
    },
  );

  if (cachedContent.htmlPathsToRunTests.length === 0) {
    cachedContent.htmlPathsToRunTests = ['/'];
  }

  return addCachedContentMainHTML(config.projectRoot, cachedContent);
}

async function addCachedContentMainHTML(projectRoot, cachedContent) {
  const mainHTMLPath = Object.keys(cachedContent.dynamicContentHTMLs)[0];
  if (mainHTMLPath) {
    cachedContent.mainHTML = {
      filePath: mainHTMLPath,
      html: cachedContent.dynamicContentHTMLs[mainHTMLPath],
    };
  } else {
    const html = await readBoilerplate('setup/tests.hbs');
    cachedContent.mainHTML = { filePath: `${projectRoot}/test/tests.html`, html };
    cachedContent.assets.add(`${projectRoot}/node_modules/qunitx/vendor/qunit.css`);
  }

  return cachedContent;
}

function splitIntoGroups(files, groupCount) {
  const groups = Array.from({ length: groupCount }, () => []);
  files.forEach((file, i) => groups[i % groupCount].push(file));
  return groups.filter((g) => g.length > 0);
}

function logWatcherAndKeyboardShortcutInfo(config, _server) {
  console.log(
    '#',
    blue(`Watching files... You can browse the tests on http://localhost:${config.port} ...`),
  );
  console.log(
    '#',
    blue(
      `Shortcuts: Press "qq" to abort running tests, "qa" to run all the tests, "qf" to run last failing test, "ql" to repeat last test`,
    ),
  );
}

function normalizeInternalAssetPathFromHTML(projectRoot, assetPath, htmlPath) {
  const currentDirectory = htmlPath ? htmlPath.split('/').slice(0, -1).join('/') : projectRoot;
  return assetPath.startsWith('./')
    ? normalize(`${currentDirectory}/${assetPath.slice(2)}`)
    : normalize(`${currentDirectory}/${assetPath}`);
}
