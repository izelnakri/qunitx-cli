import setupBrowser, { launchBrowser } from '../setup/browser.ts';
import fs from 'node:fs/promises';
import { normalize } from 'node:path';
import { availableParallelism } from 'node:os';
import { blue, yellow } from '../utils/color.ts';
import runTestsInBrowser, { buildTestBundle } from './run/tests-in-browser.ts';
import fileWatcher from '../setup/file-watcher.ts';
import findInternalAssetsFromHTML from '../utils/find-internal-assets-from-html.ts';
import runUserModule from '../utils/run-user-module.ts';
import setupKeyboardEvents from '../setup/keyboard-events.ts';
import writeOutputStaticFiles from '../setup/write-output-static-files.ts';
import timeCounter from '../utils/time-counter.ts';
import TAPDisplayFinalResult from '../tap/display-final-result.ts';
import readBoilerplate from '../utils/read-boilerplate.ts';
import type { Config, CachedContent } from '../types.ts';

/**
 * Runs qunitx tests in headless Chrome, either in watch mode or concurrent batch mode.
 * @returns {Promise<void>}
 */
export default async function run(config: Config): Promise<void> {
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
    // HTTP server and Playwright page inside one shared browser instance.
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

    console.log('TAP version 13');

    // Build all group bundles and write static files while the browser is starting up.
    const [browser] = await Promise.all([
      launchBrowser(config),
      Promise.all(
        groupConfigs.map((groupConfig, i) =>
          Promise.all([
            buildTestBundle(groupConfig, groupCachedContents[i]),
            writeOutputStaticFiles(groupConfig, groupCachedContents[i]),
          ]),
        ),
      ),
    ]);
    const TIME_COUNTER = timeCounter();

    // 3-minute per-group deadline. Firefox/WebKit can hang indefinitely in any Playwright
    // operation (browser.newPage, page.evaluate, page.close) when overwhelmed by concurrent
    // pages. Without this outer timeout, one stuck group freezes Promise.allSettled forever.
    // After all groups settle, browser.close() (below) terminates the browser and unblocks
    // any still-pending Playwright calls in background async fns.
    const GROUP_TIMEOUT_MS = 3 * 60 * 1000;

    // Keep the event loop alive during Promise.allSettled. The Chrome child process and its
    // stderr pipe are unref'd (pre-launch-chrome.js). If Chrome crashes during group cleanup,
    // all active handles close and the event loop would drain — exiting silently before
    // allSettled resolves or results are printed. This interval holds the loop open so that
    // unref'd group/page-close timers can still fire normally.
    const keepAlive = setInterval(() => {}, 1000);

    const groupResults = await Promise.allSettled(
      groupConfigs.map((groupConfig, i) => {
        const groupTimeout = new Promise((_, reject) => {
          const t = setTimeout(
            () => reject(new Error(`Group ${i} timed out after ${GROUP_TIMEOUT_MS}ms`)),
            GROUP_TIMEOUT_MS,
          );
          t.unref();
        });

        return Promise.race([
          (async () => {
            const connections = await setupBrowser(groupConfig, groupCachedContents[i], browser);
            groupConfig.expressApp = connections.server;

            if (config.before) {
              await runUserModule(`${process.cwd()}/${config.before}`, groupConfig, 'before');
            }

            try {
              await runTestsInBrowser(groupConfig, groupCachedContents[i], connections);
            } finally {
              await Promise.all([
                connections.server && connections.server.close(),
                connections.page &&
                  // Unref'd: the keepAlive interval above holds the event loop open, so this
                  // timer still fires if page.close() hangs, without preventing process exit later.
                  Promise.race([
                    connections.page.close(),
                    new Promise((resolve) => {
                      const t = setTimeout(resolve, 10000);
                      t.unref();
                    }),
                  ]).catch(() => {}),
              ]);
            }
          })(),
          groupTimeout,
        ]);
      }),
    );

    const exitCode = groupResults.reduce(
      (code, { status, reason }) => {
        if (status !== 'rejected') return code;
        console.error(reason);
        return 1;
      },
      config.COUNTER.failCount > 0 ? 1 : 0,
    );

    process.exitCode = exitCode;

    TAPDisplayFinalResult(config.COUNTER, TIME_COUNTER.stop());

    if (config.after) {
      await runUserModule(`${process.cwd()}/${config.after}`, config.COUNTER, 'after');
    }

    // Flush stdout then exit. keepAlive holds the event loop open until this callback fires,
    // at which point process.exit() takes over — so clearInterval happens here, not earlier.
    // If the write callback never fires (theoretical), the unref'd exitTimer is the fallback.
    const exitTimer = setTimeout(() => process.exit(exitCode), 5000);
    exitTimer.unref();
    process.stdout.write('\n', () => {
      clearTimeout(exitTimer);
      clearInterval(keepAlive);
      // Close browser after stdout is flushed; fire-and-forget since process.exit follows.
      browser.close().catch(() => {});
      process.exit(exitCode);
    });
  }
}

async function buildCachedContent(config: Config, htmlPaths: string[]): Promise<CachedContent> {
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

async function addCachedContentMainHTML(
  projectRoot: string,
  cachedContent: CachedContent,
): Promise<CachedContent> {
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

function splitIntoGroups(files: string[], groupCount: number): string[][] {
  const groups = Array.from({ length: groupCount }, () => []);
  files.forEach((file, i) => groups[i % groupCount].push(file));
  return groups.filter((g) => g.length > 0);
}

function logWatcherAndKeyboardShortcutInfo(config: Config, _server: unknown): void {
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

function normalizeInternalAssetPathFromHTML(
  projectRoot: string,
  assetPath: string,
  htmlPath: string,
): string {
  const currentDirectory = htmlPath ? htmlPath.split('/').slice(0, -1).join('/') : projectRoot;
  return assetPath.startsWith('./')
    ? normalize(`${currentDirectory}/${assetPath.slice(2)}`)
    : normalize(`${currentDirectory}/${assetPath}`);
}
