import { setupBrowser, launchBrowser } from '../setup/browser.ts';
import { shutdownPrelaunch } from '../utils/chrome-prelaunch.ts';
import { openOutputInBrowser } from '../utils/open-output-in-browser.ts';
import fs from 'node:fs/promises';
import { normalize } from 'node:path';
import { availableParallelism } from 'node:os';
import { blue, yellow } from '../utils/color.ts';
import { runTestsInBrowser, buildTestBundle } from './run/tests-in-browser.ts';
import { setupFileWatchers } from '../setup/file-watcher.ts';
import { findInternalAssetsFromHTML } from '../utils/find-internal-assets-from-html.ts';
import { runUserModule } from '../utils/run-user-module.ts';
import { setupKeyboardEvents } from '../setup/keyboard-events.ts';
import { writeOutputStaticFiles } from '../setup/write-output-static-files.ts';
import { timeCounter } from '../utils/time-counter.ts';
import { TAPDisplayFinalResult } from '../tap/display-final-result.ts';
import { readTemplate } from '../utils/read-template.ts';
import { isCustomTemplate } from '../utils/html.ts';
import type { Config, CachedContent } from '../types.ts';

/**
 * Runs qunitx tests in headless Chrome, either in watch mode or concurrent batch mode.
 * @returns {Promise<void>}
 */
export async function run(config: Config): Promise<void> {
  const cachedContent = await buildCachedContent(config, config.htmlPaths);

  if (config.watch) {
    // WATCH MODE: single browser, all test files bundled together.
    // The HTTP server stays alive so the user can browse http://localhost:PORT
    // and see all tests running in a single QUnit view.
    //
    // Start esbuild immediately so it races Chrome setup: Chrome connect + newPage (~150ms)
    // and esbuild (~300–600ms) have no mutual dependency until page.goto() fires inside
    // runTestsInBrowser. The promise is stored on cachedContent so runTestsInBrowser can
    // await it inside its own try/catch — errors surface as BundleErrors there, keeping
    // the watcher alive exactly as they would for a normal watch-mode build failure.
    // Suppress unhandled rejection: esbuild can fail (syntax error, missing file) before
    // setupBrowser completes. Without .catch(), Node.js detects the rejection during the
    // Promise.all window and crashes the process. runTestsInBrowser awaits this promise inside
    // its own try/catch, so the rejection is handled — but only after setupBrowser resolves.
    const preBuildPromise = buildTestBundle(config, cachedContent);
    preBuildPromise.catch(() => {});
    cachedContent._preBuildPromise = preBuildPromise;

    const [connections] = await Promise.all([
      setupBrowser(config, cachedContent),
      writeOutputStaticFiles(config, cachedContent),
    ]);
    config.expressApp = connections.server;
    setupKeyboardEvents(config, cachedContent, connections);

    // In headed watch mode (bare --open + --watch), chrome-prelaunch.ts launches Chrome
    // without --headless=new so the Playwright-controlled window IS the visible browser.
    // Calling openOutputInBrowser here would open a SECOND Chrome window (a third if the
    // user already has Chrome running and Chrome sends the URL to each open instance).
    // For --open=<browser> (a string) Playwright stays headless, so the named binary is
    // the only visible browser and openOutputInBrowser must still be called.
    const isHeadedWatchMode = config.open === true && config.watch;
    if (config.open && !isHeadedWatchMode) {
      void openOutputInBrowser(config);
    }

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

    // In headed watch mode, navigate the Playwright page to the error HTML when the
    // initial build failed. On a successful run, runTestInsideHTMLFile already navigated
    // the page; this only fires for the build-error path where page.goto was never called
    // and the page is still at about:blank.
    if (isHeadedWatchMode && cachedContent._buildError) {
      await connections.page
        .goto(`http://localhost:${config.port}/`, { waitUntil: 'commit', timeout: 5000 })
        .catch(() => {});
    }

    if (config.watch) {
      const { ready: watcherReady } = setupFileWatchers(
        config.testFileLookupPaths,
        config,
        async (event, file) => {
          if (event === 'addDir') return;
          if (['change', 'unlink', 'unlinkDir'].includes(event)) {
            // Ignore `change` events for files not yet in fsTree: fs.watch fires `change`
            // before `rename` (→ `add`) when a file is first created. The `add` event
            // will follow and trigger the correct filtered re-run.
            if (event === 'change' && !(file in config.fsTree)) return;
            // Clear the cached bundle so the next full re-run rebuilds without the deleted file.
            // `change` events can fire while a file is being rewritten, so a filtered bundle
            // may catch the file in a transient empty/partial state and produce a broken rerun.
            cachedContent.allTestCode = null;
            if (config.debug) {
              console.log(
                `# Rerun triggered: ${event} → ${file.replace(`${config.projectRoot}/`, '')}`,
              );
            }
            return await runTestsInBrowser(config, cachedContent, connections);
          }
          if (config.debug) {
            console.log(
              `# Rerun triggered: ${event} → ${file.replace(`${config.projectRoot}/`, '')}`,
            );
          }
          await runTestsInBrowser(config, cachedContent, connections, [file]);
        },
        async (_path, _event) => {
          connections.server.publish('refresh');
          // In headed watch mode the Playwright page IS the visible browser (IS_PLAYWRIGHT=true
          // means it ignores the WS 'refresh' message). Navigate it directly after a build error
          // so it shows the error HTML rather than stale test results.
          if (isHeadedWatchMode && cachedContent._buildError) {
            await connections.page
              .goto(`http://localhost:${config.port}/`, { waitUntil: 'commit', timeout: 5000 })
              .catch(() => {});
          }
        },
      );
      await watcherReady;
    }

    logWatcherAndKeyboardShortcutInfo(config, connections.server);
  } else {
    // CONCURRENT MODE: split test files across N groups = availableParallelism().
    // All group bundles are built while Chrome is starting up, so esbuild time
    // is hidden behind the ~1.2s Chrome launch. Each group then gets its own
    // HTTP server and Playwright page inside one shared browser instance.
    const allFiles = Object.keys(config.fsTree);
    const groupCount = Math.min(allFiles.length, availableParallelism());
    const groups = splitIntoGroups(allFiles, groupCount);

    // Shared COUNTER so TAP test numbers are globally sequential across all groups.
    config.COUNTER = {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    };
    config.lastRanTestFiles = allFiles;

    const groupConfigs = groups.map((groupFiles, i) => ({
      ...config,
      fsTree: Object.fromEntries(groupFiles.map((filePath) => [filePath, config.fsTree[filePath]])),
      // Single group keeps the root output dir for backward-compatible file paths.
      output: groupCount === 1 ? config.output : `${config.output}/group-${i}`,
      _groupMode: true,
      _phase: 'bundling' as Config['_phase'],
    }));
    const groupCachedContents = groups.map(() => ({ ...cachedContent }));

    process.stdout.write('TAP version 13\n');
    process.stdout.write(
      `# Running ${allFiles.length} test file${allFiles.length === 1 ? '' : 's'} across ${groupCount} group${groupCount === 1 ? '' : 's'}\n`,
    );

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

    // Open immediately after static files are ready — no need to wait for tests to finish.
    if (config.open) {
      void openOutputInBrowser(config);
    }
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
          const timeoutId = setTimeout(() => {
            const files = Object.keys(groupConfig.fsTree).map((filePath) =>
              filePath.replace(`${groupConfig.projectRoot}/`, ''),
            );
            reject(
              new Error(
                `Group ${i} timed out after ${GROUP_TIMEOUT_MS / 1000}s in phase '${groupConfig._phase ?? 'unknown'}'\n  Files: ${files.join(', ')}`,
              ),
            );
          }, GROUP_TIMEOUT_MS);
          timeoutId.unref();
        });

        return Promise.race([
          (async () => {
            groupConfig._phase = 'connecting';
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
                      const pageCloseTimeoutId = setTimeout(resolve, 10000);
                      pageCloseTimeoutId.unref();
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

    // Flush stdout, shut down Chrome cleanly, then exit.
    // keepAlive holds the event loop open until this callback fires, at which point
    // process.exit() takes over — so clearInterval happens here, not earlier.
    // If the write callback never fires (theoretical), the unref'd exitTimer is the fallback.
    const exitTimer = setTimeout(() => process.exit(exitCode), 5000);
    exitTimer.unref();

    process.stdout.write('\n', async () => {
      clearTimeout(exitTimer);
      clearInterval(keepAlive);
      await browser.close().catch(() => {});
      await shutdownPrelaunch();
      process.exit(exitCode);
    });
  }
}

async function buildCachedContent(config: Config, htmlPaths: string[]): Promise<CachedContent> {
  const htmlBuffers = await Promise.all(
    config.htmlPaths.map((htmlPath) => fs.readFile(htmlPath).catch(() => null)),
  );
  const cachedContent = htmlPaths.reduce(
    (result, _htmlPath, index) => {
      const buffer = htmlBuffers[index];
      if (buffer === null) return result;
      const filePath = config.htmlPaths[index];
      const html = buffer.toString();

      if (isCustomTemplate(html)) {
        result.dynamicContentHTMLs[filePath] = html;
        result.htmlPathsToRunTests.push(filePath.replace(config.projectRoot, ''));
      } else {
        console.log(
          '#',
          yellow(
            `WARNING: Static html file with no {{qunitxScript}} or handlebars-style tokens detected. Therefore ignoring ${filePath}`,
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
    const html = await readTemplate('setup/tests.hbs');
    cachedContent.mainHTML = { filePath: `${projectRoot}/test/tests.html`, html };
    cachedContent.assets.add(`${projectRoot}/node_modules/qunitx/vendor/qunit.css`);
  }

  return cachedContent;
}

function splitIntoGroups(files: string[], groupCount: number): string[][] {
  const groups = Array.from({ length: groupCount }, () => []);
  files.forEach((file, i) => groups[i % groupCount].push(file));
  return groups.filter((group) => group.length > 0);
}

function logWatcherAndKeyboardShortcutInfo(config: Config, _server: unknown): void {
  const prefix = 'Watching files...';
  console.log(
    '#',
    blue(`${prefix} You can browse the tests on http://localhost:${config.port} ...`),
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

export { run as default };
