import { setupBrowser, launchBrowser } from '../setup/browser.ts';
import { shutdownPrelaunch } from '../utils/chrome-prelaunch.ts';
import { HTTPServer } from '../servers/http.ts';
import { bindServerToPort } from '../setup/bind-server-to-port.ts';
import {
  registerGroupRoutes,
  setupGroupWSHandler,
  registerSharedStaticHandler,
} from '../setup/web-server.ts';
import { openOutputInBrowser } from '../utils/open-output-in-browser.ts';
import fs from 'node:fs/promises';
import { normalize } from 'node:path';
import { availableParallelism } from 'node:os';
import { blue, yellow } from '../utils/color.ts';
import {
  runTestsInBrowser,
  buildTestBundle,
  buildAllGroupBundles,
  flushConsoleHandlers,
} from './run/tests-in-browser.ts';
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

// Playwright navigation timeout for headed watch-mode reloads (not test execution).
const WATCH_NAV_TIMEOUT_MS = 5_000;
// Maximum ms to wait for page.close() before giving up and moving on (group mode).
const PAGE_CLOSE_GRACE_MS = 10_000;
// Maximum ms to wait for stdout to flush before forcing process.exit().
const STDOUT_FLUSH_GRACE_MS = 5_000;
// setInterval period that keeps the event loop alive while Promise.allSettled runs.
const KEEP_ALIVE_INTERVAL_MS = 10_000;

/**
 * Runs qunitx tests in headless Chrome, either in watch mode or concurrent batch mode.
 * @returns {Promise<void>}
 */
export async function run(config: Config): Promise<void> {
  // Kick off all I/O that doesn't need cachedContent in parallel with buildCachedContent:
  //   launchBrowser: CDP connect to pre-launched Chrome (~30-50ms)
  //   readTimingCache: reads tmp/test-timings.json (~2ms)
  //   buildCachedContent: reads HTML template from disk (~5-10ms)
  // Chrome is typically fully connected by the time buildCachedContent + splitIntoGroups resolve.
  const browserPromise = config.watch ? null : launchBrowser(config);
  const [cachedContent, timings] = await Promise.all([
    buildCachedContent(config, config.htmlPaths),
    config.watch
      ? Promise.resolve(null as Record<string, number> | null)
      : readTimingCache(config.projectRoot),
  ]);

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
    config.webServer = connections.server;
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

    // In headed watch mode, navigate the Playwright page to the special-state HTML when the
    // initial run produced a build error or a 0-tests warning.
    // - Build error: page.goto was never called (runTestInsideHTMLFile bailed before navigation),
    //   so the page is still at about:blank.
    // - No-tests warning: page.goto WAS called (the page loaded normal QUnit HTML with 0 tests),
    //   but _noTestsWarning is set only AFTER runTestInsideHTMLFile returns, so we must
    //   re-navigate so the route handler can now serve the warning page.
    if (isHeadedWatchMode && (cachedContent._buildError || cachedContent._noTestsWarning)) {
      await connections.page
        .goto(`http://localhost:${config.port}/`, {
          waitUntil: 'commit',
          timeout: WATCH_NAV_TIMEOUT_MS,
        })
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
            // Kick off rebuild immediately so it races Chrome navigation (same pattern as the
            // initial watch-mode build). runTestsInBrowser picks up the promise from
            // _preBuildPromise and sets _activeRebuild so /tests.js can await it.
            const rebuildPromise = buildTestBundle(config, cachedContent);
            rebuildPromise.catch(() => {});
            cachedContent._preBuildPromise = rebuildPromise;
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
          // In headed watch mode the Playwright page IS the visible browser (navigator.webdriver=true
          // means it ignores the WS 'refresh' message). Navigate it directly after a build error
          // or a 0-tests warning so it shows the correct HTML rather than stale test results.
          if (isHeadedWatchMode && (cachedContent._buildError || cachedContent._noTestsWarning)) {
            await connections.page
              .goto(`http://localhost:${config.port}/`, {
                waitUntil: 'commit',
                timeout: WATCH_NAV_TIMEOUT_MS,
              })
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
    const { groups, weights } = await splitIntoGroups(allFiles, groupCount, timings ?? {});

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

    // One shared HTTPServer for all groups (routed by /group-{i}/ prefix) when using the
    // default '/' HTML path. Falls back to per-group servers for custom HTML templates.
    const sharedServer =
      groupCount > 1 &&
      cachedContent.htmlPathsToRunTests[0] === '/' &&
      cachedContent.htmlPathsToRunTests.length === 1
        ? (() => {
            const s = new HTTPServer();
            setupGroupWSHandler(s, groupConfigs);
            groupConfigs.forEach((gc, i) => registerGroupRoutes(s, gc, groupCachedContents[i], i));
            registerSharedStaticHandler(s, groupConfigs);
            return s;
          })()
        : null;

    process.stdout.write('TAP version 13\n');
    process.stdout.write(
      `# Running ${allFiles.length} test file${allFiles.length === 1 ? '' : 's'} across ${groupCount} group${groupCount === 1 ? '' : 's'}\n`,
    );

    // Build all group bundles and write static files while the browser is starting up.
    // Bind the shared server's port in the same parallel window when active.
    const [browser] = await Promise.all([
      browserPromise!,
      sharedServer
        ? bindServerToPort(sharedServer, config).then(() =>
            groupConfigs.forEach((gc, i) => {
              gc.port = config.port;
              groupCachedContents[i].htmlPathsToRunTests = [`/group-${i}/`];
            }),
          )
        : Promise.resolve(),
      Promise.all([
        groupCount > 1
          ? buildAllGroupBundles(groupConfigs, groupCachedContents)
          : buildTestBundle(groupConfigs[0], groupCachedContents[0]),
        Promise.all(
          groupConfigs.map((gc, i) => writeOutputStaticFiles(gc, groupCachedContents[i])),
        ),
      ]),
    ]);

    // Open immediately after static files are ready — no need to wait for tests to finish.
    if (config.open) {
      void openOutputInBrowser(config);
    }
    const TIME_COUNTER = timeCounter();
    const wallTimes = new Map<number, number>();

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
    const keepAlive = setInterval(() => {}, KEEP_ALIVE_INTERVAL_MS);

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

        const startMs = Date.now();
        const work = (async () => {
          groupConfig._phase = 'connecting';
          const connections = await setupBrowser(
            groupConfig,
            groupCachedContents[i],
            browser,
            sharedServer,
          );
          groupConfig.webServer = connections.server;

          if (config.before) {
            await runUserModule(`${process.cwd()}/${config.before}`, groupConfig, 'before');
          }

          try {
            await runTestsInBrowser(groupConfig, groupCachedContents[i], connections);
          } finally {
            await flushConsoleHandlers(groupConfig._pendingConsoleHandlers);
            await Promise.all([
              !sharedServer && connections.server?.close(),
              connections.page &&
                // Unref'd: the keepAlive interval above holds the event loop open, so this
                // timer still fires if page.close() hangs, without preventing process exit later.
                Promise.race([
                  connections.page.close(),
                  new Promise((resolve) => {
                    const pageCloseTimeoutId = setTimeout(resolve, PAGE_CLOSE_GRACE_MS);
                    pageCloseTimeoutId.unref();
                  }),
                ]).catch(() => {}),
            ]);
          }
        })();
        const record = () => wallTimes.set(i, Date.now() - startMs);
        work.then(record, record);
        return Promise.race([work, groupTimeout]);
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

    if (config.COUNTER.testCount === 0 && exitCode === 0) {
      const fileWord = allFiles.length === 1 ? 'file' : 'files';
      console.log(
        `# Warning: 0 tests registered — no QUnit test cases found in ${allFiles.length} ${fileWord}`,
      );
    }

    TAPDisplayFinalResult(config.COUNTER, TIME_COUNTER.stop());

    const fileTimes = computeFileTimes(groups, weights, wallTimes);
    persistTimings(fileTimes, config.projectRoot).catch(
      (err: Error) =>
        config.debug && process.stderr.write(`# [qunitx] persistTimings: ${err.message}\n`),
    );
    printFileTimings(fileTimes, config.projectRoot);

    if (config.after) {
      await runUserModule(`${process.cwd()}/${config.after}`, config.COUNTER, 'after');
    }

    // Flush stdout, shut down Chrome cleanly, then exit.
    // keepAlive holds the event loop open until this callback fires, at which point
    // process.exit() takes over — so clearInterval happens here, not earlier.
    // If the write callback never fires (theoretical), the unref'd exitTimer is the fallback.
    const exitTimer = setTimeout(() => process.exit(exitCode), STDOUT_FLUSH_GRACE_MS);
    exitTimer.unref();

    process.stdout.write('\n', async () => {
      clearTimeout(exitTimer);
      clearInterval(keepAlive);
      await Promise.all([
        sharedServer
          ?.close()
          .catch(
            (err: Error) =>
              config.debug && process.stderr.write(`# [qunitx] server.close: ${err.message}\n`),
          ),
        browser
          .close()
          .catch(
            (err: Error) =>
              config.debug && process.stderr.write(`# [qunitx] browser.close: ${err.message}\n`),
          ),
      ]);
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

/** Reads `tmp/test-timings.json` from projectRoot; returns `{}` on any error or invalid content. */
async function readTimingCache(projectRoot: string): Promise<Record<string, number>> {
  try {
    const parsed = JSON.parse(await fs.readFile(`${projectRoot}/tmp/test-timings.json`, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Distributes each group's wall-clock ms to its files proportionally by LPT weight. */
function computeFileTimes(
  groups: string[][],
  weights: Map<string, number>,
  wallTimes: Map<number, number>,
): Map<string, number> {
  const result = new Map<string, number>();
  groups.forEach((group, i) => {
    const wallMs = wallTimes.get(i);
    if (wallMs === undefined) return;
    const total = group.reduce((sum, f) => sum + (weights.get(f) ?? 0), 0);
    group.forEach((f) =>
      result.set(f, total > 0 ? wallMs * ((weights.get(f) ?? 0) / total) : wallMs / group.length),
    );
  });
  return result;
}

async function persistTimings(fileTimes: Map<string, number>, projectRoot: string): Promise<void> {
  await fs.writeFile(
    `${projectRoot}/tmp/test-timings.json`,
    JSON.stringify(Object.fromEntries(fileTimes), null, 2),
  );
}

function printFileTimings(fileTimes: Map<string, number>, projectRoot: string): void {
  if (fileTimes.size === 0) return;
  const lines = [...fileTimes.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([f, ms]) => `#   ${ms.toFixed(0)}ms  ${f.replace(`${projectRoot}/`, '')}`);
  process.stdout.write(`# File execution times:\n${lines.join('\n')}\n`);
}

// LPT (Longest Processing Time first) bin-packing: sort files by estimated time descending,
// then assign each to the group with the smallest current total. Uses cached per-file timings
// when available; falls back to file size scaled by msPerByte for unknown files.
async function splitIntoGroups(
  files: string[],
  groupCount: number,
  timings: Record<string, number>,
): Promise<{ groups: string[][]; weights: Map<string, number> }> {
  const sizes = await Promise.all(
    files.map((f) =>
      timings[f] > 0
        ? Promise.resolve(0)
        : fs
            .stat(f)
            .then((s) => s.size)
            .catch(() => 0),
    ),
  );
  const knownRates = files
    .map((f, i) => ({ ms: timings[f], size: sizes[i] }))
    .filter(({ ms, size }) => ms > 0 && size > 0);
  const msPerByte =
    knownRates.length > 0
      ? knownRates.reduce((sum, { ms, size }) => sum + ms / size, 0) / knownRates.length
      : 1;
  const weights = new Map(
    files.map((f, i) => [f, timings[f] > 0 ? timings[f] : sizes[i] * msPerByte]),
  );
  const buckets = Array.from({ length: groupCount }, () => ({ files: [] as string[], total: 0 }));
  [...files]
    .sort((a, b) => (weights.get(b) ?? 0) - (weights.get(a) ?? 0))
    .forEach((f) => {
      const min = buckets.reduce((m, _, i) => (buckets[i].total < buckets[m].total ? i : m), 0);
      buckets[min].files.push(f);
      buckets[min].total += weights.get(f) ?? 0;
    });
  return { groups: buckets.filter((b) => b.files.length > 0).map((b) => b.files), weights };
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

export { readTimingCache, computeFileTimes };
export { run as default };
