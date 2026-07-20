import { setupBrowser, launchBrowser } from '../setup/browser.ts';
import { shutdownPrelaunch } from '../chrome/prelaunch.ts';
import { HTTPServer } from '../servers/web.ts';
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
// node:timers returns Timer objects with .unref()/.ref() in both Node and Deno.
// The bare `setTimeout` global in Deno is the Web platform variant, which returns
// a number with no unref method.
import { setTimeout, clearTimeout, setInterval, clearInterval } from 'node:timers';
import { blue, yellow } from '../utils/color.ts';
import {
  runTestsInBrowser,
  buildTestBundle,
  buildAllGroupBundles,
  flushConsoleHandlers,
  DaemonRunError,
} from './run/tests-in-browser.ts';
import { clearCachedBundles } from './run/cached-bundles.ts';
import { newGroupState, resetRunResults, reusablePageSlot } from '../setup/run-state.ts';
import { setupFileWatchers } from '../setup/file-watcher.ts';
import { getChangedFsTree } from '../setup/get-changed-fs-tree.ts';
import { findInternalAssetsFromHTML } from '../utils/find-internal-assets-from-html.ts';
import { runUserModule } from '../utils/run-user-module.ts';
import { setupKeyboardEvents } from '../setup/keyboard-events.ts';
import { writeOutputStaticFiles } from '../setup/write-output-static-files.ts';
import { timeCounter } from '../utils/time-counter.ts';
import { reportRunStart, reportRunEnd } from '../reporter/index.ts';
import { readTemplate } from '../utils/read-template.ts';
import { isCustomTemplate } from '../utils/html.ts';
import { closeWithGrace } from '../utils/close-with-grace.ts';
import { maybePrintDaemonHint } from './daemon/hint.ts';
import {
  writeFailureCache,
  buildFailureCache,
  resolveOnlyFailedFiles,
} from '../utils/failure-cache.ts';
import { writeCoverageReport } from '../coverage/report.ts';
import { isFilteredRun, describeFilter } from '../selection/filter-query.ts';
import {
  readTimingCache,
  computeFileTimes,
  persistTimings,
  printFileTimings,
} from './run/timings.ts';
import { applyWatchLineTargets, resolveTargetedFiles, splitIntoGroups } from './run/grouping.ts';
import type { QUnitSelector } from '../selection/line-targets.ts';
import type { Config, CachedContent, HtmlAssets } from '../types.ts';

// Playwright navigation timeout for headed watch-mode reloads (not test execution).
const WATCH_NAV_TIMEOUT_MS = 5_000;
// Maximum ms to wait for the `process.stdout.write` drain callback to fire before
// forcing process.exit(). On Windows under concurrent CI load (16 parallel tests)
// the drain callback can take far longer than expected: the parent reader is busy,
// the OS pipe buffer fills, Node's userland write queue stalls until the reader
// catches up. The original 5s was too tight — exitTimer fired first and process.exit
// dropped pending writes (the `--after works when it needs to be awaited` flake
// reported only the pre-await TAP-13 header). 30s gives realistic headroom; nothing
// in node:fs can force-drain Node's userland queue (fsync would only flush the OS
// pipe buffer, not Node's queue — and pipes have no backing store on POSIX anyway),
// so the only honest fix is to wait longer for the natural drain.
const STDOUT_FLUSH_GRACE_MS = 30_000;
// setInterval period that keeps the event loop alive while Promise.allSettled runs.
const KEEP_ALIVE_INTERVAL_MS = 10_000;
// Daemon-only bound on the "connecting" phase (setupBrowser → newPage on the reused
// browser). newPage() is the one connecting step with no timeout — it only rejects once
// Playwright observes the transport close, which under load can lag a browser that died in
// the microsecond window after the pre-run liveness probe passed. Without a bound, that
// wedges the run on the 180s GROUP_TIMEOUT and hangs the client (no timeout of its own).
// 30s is orders of magnitude over a healthy connect (sub-second) yet well under the group
// deadline, so it only ever fires on a genuine wedge; the daemon then recovers for the next
// run. Local runs launch a fresh browser per invocation, so this race can't apply there.
const DAEMON_CONNECT_TIMEOUT_MS = 30_000;
// Conventional exit code for a process terminated by SIGTERM (128 + signal number 15).
const EXIT_CODE_SIGTERM = 128 + 15;

/**
 * Runs qunitx tests in headless Chrome, either in watch mode or concurrent batch mode.
 * @returns {Promise<void>}
 */
export async function run(config: Config): Promise<void> {
  // Coverage is V8-precise-coverage over CDP, which only the chromium engine exposes. For
  // firefox/webkit, warn once and disable so the rest of the pipeline treats it as off.
  if (config.coverage && config.browser !== 'chromium') {
    console.log(
      `# Warning: --coverage requires the chromium browser; skipping coverage for ${config.browser}.`,
    );
    config.coverage = false;
  }

  // Kick off all I/O that doesn't need cachedContent in parallel with buildCachedContent:
  //   launchBrowser: CDP connect to pre-launched Chrome (~30-50ms)
  //   readTimingCache: reads tmp/test-timings.json (~2ms)
  //   buildCachedContent: reads HTML template from disk (~5-10ms)
  // Chrome is typically fully connected by the time buildCachedContent + splitIntoGroups resolve.
  // Daemon mode reuses its persistent browser; non-watch local runs launch their own;
  // watch mode defers launch until setupBrowser inside the watch path.
  const daemonBrowser = config.state.daemon?.browser;
  const browserPromise = daemonBrowser
    ? Promise.resolve(daemonBrowser)
    : config.watch
      ? null
      : launchBrowser(config);
  const [cachedContent, timings] = await Promise.all([
    buildCachedContent(config, config.htmlPaths),
    config.watch
      ? Promise.resolve(null as Record<string, number> | null)
      : readTimingCache(config.projectRoot),
  ]);

  if (config.watch) {
    await runWatchMode(config, cachedContent);
  } else {
    await runConcurrentMode(config, cachedContent, timings, browserPromise);
  }
}

/**
 * WATCH MODE: one browser, one page, every test file in a single bundle, behind an HTTP server
 * that stays up so the QUnit view can be kept open. Reruns are driven by the file watcher and the
 * keyboard shortcuts, so this returns with the process still alive.
 */
async function runWatchMode(config: Config, cachedContent: CachedContent): Promise<void> {
  // Line targets scope the whole watch session, so they have to narrow fsTree BEFORE the
  // bundle below is built from it — see applyWatchLineTargets. Guarded so the common path
  // keeps starting esbuild without an extra await.
  if (config.lineTargets && Object.keys(config.lineTargets).length > 0) {
    await applyWatchLineTargets(config);
  }
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
    writeOutputStaticFiles(config, config.state.htmlAssets),
  ]);
  config.webServer = connections.server;
  setupKeyboardEvents(config, cachedContent, connections);

  // Explicitly close the HTTP server on SIGTERM before the process exits. This ensures
  // the port is reclaimed by application code (not as a side effect of OS process cleanup),
  // guaranteeing the port is free from the moment waitpid() returns in the parent process.
  // Without this, macOS can lag a few ms between waitpid() and socket reclamation, making
  // the port appear in-use immediately after the child exits.
  // Note: on Windows child.kill('SIGTERM') calls TerminateProcess() so this handler never
  // runs there — but TerminateProcess() is fully synchronous so the race doesn't exist on
  // Windows anyway. Exit with 143 (128 + SIGTERM) to preserve the conventional exit code.
  process.once('SIGTERM', () => {
    closeWithGrace([connections.server.close()]).finally(() => process.exit(EXIT_CODE_SIGTERM));
  });

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

  // A run-narrowing flag (--only-failed / --changed / --since) scopes only the FIRST run in
  // watch mode. The full fsTree is left intact (setupConfig skips these filters in watch), so
  // `qa` and file-save reruns still see every file; `qf` / `ql` cover the rest interactively.
  let initialFilter: string[] | undefined;
  if (config.onlyFailed) {
    const failed = await resolveOnlyFailedFiles(
      config.projectRoot,
      config.inputs.length > 0,
      config.fsTree,
    );
    if (failed && failed.length > 0) {
      initialFilter = failed;
      console.log(
        '#',
        blue(
          `qunitx --only-failed: first run scoped to ${failed.length} previously-failing test file${failed.length === 1 ? '' : 's'} — press "qa" to run all`,
        ),
      );
    } else {
      console.log('#', blue(`qunitx --only-failed: no cached failures — running all tests`));
    }
  } else if (config.changedSince) {
    // getChangedFsTree logs its own affected/fallback counts and returns the full tree on
    // fallback (cold metafile / git failure / blast-radius); scope only when it narrowed.
    const changed = Object.keys(
      await getChangedFsTree(config.fsTree, config.projectRoot, config.changedSince),
    );
    if (changed.length < Object.keys(config.fsTree).length) {
      initialFilter = changed;
      if (changed.length > 0) {
        console.log(
          '#',
          blue(`qunitx --changed/--since: first run scoped — press "qa" to run all`),
        );
      }
    }
  }

  try {
    await runTestsInBrowser(config, cachedContent, connections, initialFilter);
  } catch (error) {
    await closeWithGrace([connections.server?.close(), connections.browser?.close()]);
    throw error;
  }

  // In headed watch mode, navigate the Playwright page to the special-state HTML when the
  // initial run produced a build error or a 0-tests warning.
  // - Build error: page.goto was never called (runTestInsideHTMLFile bailed before navigation),
  //   so the page is still at about:blank.
  // - No-tests warning: page.goto WAS called (the page loaded normal QUnit HTML with 0 tests),
  //   but the no-tests override is set only AFTER runTestInsideHTMLFile returns, so we must
  //   re-navigate so the route handler can now serve the warning page.
  if (isHeadedWatchMode && cachedContent.pageOverride) {
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
          // Clear the cached bundles so the next re-run rebuilds without the deleted file.
          // `change` events can fire while a file is being rewritten, so a filtered bundle
          // may catch the file in a transient empty/partial state and produce a broken rerun.
          clearCachedBundles(cachedContent);
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
        if (isHeadedWatchMode && cachedContent.pageOverride) {
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
}

/**
 * CONCURRENT MODE: the one-shot batch run. Files are split across groups, each group getting its
 * own page inside one shared browser so esbuild time hides behind Chrome start-up. Ends the
 * process itself — reporting, cache persistence and cleanup all happen here.
 */
async function runConcurrentMode(
  config: Config,
  cachedContent: CachedContent,
  timings: Record<string, number> | null,
  browserPromise: ReturnType<typeof launchBrowser> | null,
): Promise<void> {
  // CONCURRENT MODE: split test files across N groups = availableParallelism().
  // All group bundles are built while Chrome is starting up, so esbuild time
  // is hidden behind the ~1.2s Chrome launch. Each group then gets its own
  // HTTP server and Playwright page inside one shared browser instance.
  const allFiles = Object.keys(config.fsTree);
  // Empty fsTree (e.g. --changed filtered out every test, or the inputs
  // matched no files): emit a clean TAP plan and exit 0. The downstream
  // group/build pipeline assumes ≥1 file and would crash on undefined
  // groupConfigs[0]. In daemon mode, throw DaemonRunError so the daemon's
  // run handler closes the run cleanly and stays alive for the next call.
  if (allFiles.length === 0) {
    reportRunStart(config, { fileCount: 0, groupCount: 0 });
    if (config.state.daemon) throw new DaemonRunError(0);
    if (!config.watch) {
      // Daemon runs threw above, so this is always a browser this run owns and must close.
      const browser = await browserPromise!;
      await closeWithGrace([browser.close(), shutdownPrelaunch()]);
      return process.exit(0);
    }
    return;
  }
  // Line-targeted files run as their own single-file groups, each carrying its own selectors.
  // A group is one page with one QUnit config, so this is what lets `a.ts#34 b.ts` mean "the
  // one test in a.ts, all of b.ts" — a shared page could only express one filter for both.
  const targets = await resolveTargetedFiles(config, allFiles);
  const targetedPaths = new Set(targets.map((target) => target.file));
  const untargetedFiles = allFiles.filter((file) => !targetedPaths.has(file));
  // Each targeted file already occupies a page of its own, so the untargeted files spread across
  // whatever cores are left — never more groups than files, never fewer than one.
  const untargetedGroupCount = Math.max(
    1,
    Math.min(untargetedFiles.length, availableParallelism() - targets.length),
  );
  const { groups: untargetedGroups, weights } = untargetedFiles.length
    ? await splitIntoGroups(untargetedFiles, untargetedGroupCount, timings ?? {})
    : { groups: [] as string[][], weights: new Map<string, number>() };
  // One entry per group: the files it bundles and the selectors that scope it
  // (undefined = no line targets, run those files whole).
  const groups: Array<{ files: string[]; selectors: QUnitSelector[] | undefined }> = [
    ...targets.map((target) => ({ files: [target.file], selectors: target.selectors })),
    ...untargetedGroups.map((files) => ({ files, selectors: undefined })),
  ];
  const groupCount = groups.length;
  // Shared with every group config below; reusablePageSlot() reads it to decide page reuse.
  config.state.groupCount = groupCount;

  // All run accumulators — counter, failure sets, coverage — are cleared here, on the parent,
  // BEFORE the group configs are spread off it below. The spread copies `state` by reference, so
  // every group then adds into these same objects: TAP numbers stay globally sequential, failures
  // land in one set, and the coverage report covers the whole run rather than one group's slice.
  resetRunResults(config.state.results, !!config.coverage);
  config.state.group.ranFiles = allFiles;

  const groupConfigs = groups.map(({ files, selectors }, i) => ({
    ...config,
    fsTree: Object.fromEntries(files.map((filePath) => [filePath, config.fsTree[filePath]])),
    // Single group keeps the root output dir for backward-compatible file paths.
    output: groupCount === 1 ? config.output : `${config.output}/group-${i}`,
    // Everything else on `state` is deliberately shared by reference (see RunState); only
    // `group` is replaced. That gives each group its own signals, phase, selectors and testEnd
    // dedup map — the last one matters because two groups can legitimately share a test
    // fullName when they bundle different files registering the same module/test names, so
    // deduping has to be intra-group or group B's first testEnd would be dropped as group A's
    // duplicate.
    state: { ...config.state, group: { ...newGroupState(i, selectors), groupMode: true } },
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

  reportRunStart(config, { fileCount: allFiles.length, groupCount });

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
      Promise.all(groupConfigs.map((gc) => writeOutputStaticFiles(gc, gc.state.htmlAssets))),
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
              `Group ${i} timed out after ${GROUP_TIMEOUT_MS / 1000}s in phase '${groupConfig.state.group.phase ?? 'unknown'}'\n  Files: ${files.join(', ')}`,
            ),
          );
        }, GROUP_TIMEOUT_MS);
        timeoutId.unref();
      });

      const startMs = Date.now();
      const work = (async () => {
        groupConfig.state.group.phase = 'connecting';
        const connectWork = setupBrowser(
          groupConfig,
          groupCachedContents[i],
          browser,
          sharedServer,
        );
        // Daemon runs reuse a persistent browser; bound the connect so a handle that
        // died just after the pre-run probe fails fast here (recovered next run) instead
        // of wedging until GROUP_TIMEOUT. See DAEMON_CONNECT_TIMEOUT_MS.
        const connections = config.state.daemon
          ? await Promise.race([
              connectWork,
              new Promise<never>((_, reject) => {
                const t = setTimeout(
                  () =>
                    reject(
                      new Error(
                        `Group ${i} browser connect timed out after ${DAEMON_CONNECT_TIMEOUT_MS / 1000}s — the daemon's browser appears to have died mid-connect`,
                      ),
                    ),
                  DAEMON_CONNECT_TIMEOUT_MS,
                );
                t.unref();
              }),
            ])
          : await connectWork;
        groupConfig.webServer = connections.server;

        if (config.before) {
          await runUserModule(`${process.cwd()}/${config.before}`, groupConfig, 'before');
        }

        try {
          await runTestsInBrowser(groupConfig, groupCachedContents[i], connections);
        } finally {
          await flushConsoleHandlers(
            groupConfig.state.group.pendingConsoleHandlers,
            connections.page,
          );
          // Daemon single-group fast path: stash the page on the slot for the next run instead
          // of closing it (saves ~70-130ms of newPage cost per warm run). Mid-page state is
          // dropped by the next run's page.goto(testUrl), which destroys the JS context.
          // reusablePageSlot() withholds the slot outside single-group daemon runs, and a
          // disconnected page falls through to close.
          const pageSlot = reusablePageSlot(groupConfig.state);
          const reusePage = pageSlot && connections.page && !connections.page.isClosed();
          if (reusePage) pageSlot.page = connections.page;
          // Per-group cleanup, bounded so a deadlocked page.close (Firefox/WebKit under
          // load) cannot wedge Promise.allSettled forever. The shared server is closed
          // in the final cleanup pass below, not here.
          await closeWithGrace([
            sharedServer ? undefined : connections.server?.close(),
            reusePage ? undefined : connections.page?.close(),
          ]);
        }
      })();
      const record = () => wallTimes.set(i, Date.now() - startMs);
      work.then(record, record);
      return Promise.race([work, groupTimeout]);
    }),
  );

  let exitCode = groupResults.reduce(
    (code, { status, reason }) => {
      if (status !== 'rejected') return code;
      console.error(reason);
      return 1;
    },
    config.state.results.counter.failCount > 0 ? 1 : 0,
  );

  if (config.state.results.counter.testCount === 0 && exitCode === 0) {
    if (isFilteredRun(config)) {
      // A filter matching nothing is a typo, not a green run — every neighbouring runner
      // fails here, and passing CI on a mistyped -t is the worst outcome available.
      console.log(`# No tests matched ${describeFilter(config)}`);
      exitCode = 1;
    } else {
      const fileWord = allFiles.length === 1 ? 'file' : 'files';
      console.log(
        `# Warning: 0 tests registered — no QUnit test cases found in ${allFiles.length} ${fileWord}`,
      );
    }
  }

  // Set after the zero-match block above, which can flip exitCode to 1 for a filter that
  // matched nothing.
  process.exitCode = exitCode;

  await reportRunEnd(config, { durationMs: TIME_COUNTER.stop() });

  if (config.coverage) await writeCoverageReport(config, allFiles);

  // A test-level filter (-t/-m/line target) makes both caches lie: a file that ran 1 of its
  // 30 tests records ~1/30th of its wall time, which mis-packs every future full run, and its
  // failure set is only the matched subset. File-level narrowing (--only-failed/--changed) is
  // fine — those still run whole files.
  const filteredRun = isFilteredRun(config);
  const fileTimes = computeFileTimes(
    groups.map((group) => group.files),
    weights,
    wallTimes,
  );
  if (!filteredRun) {
    persistTimings(fileTimes, config.projectRoot).catch(
      (err: Error) =>
        config.debug && process.stderr.write(`# [qunitx] persistTimings: ${err.message}\n`),
    );
  }
  // Persist this run's failures for the next `--only-failed`. An empty set (all green) is
  // written too, so a passing re-run clears the cache. Awaited on the exit path below (unlike
  // timings, which tolerate loss) so a slow filesystem can't lose the cache to process.exit.
  const failureCacheWrite = filteredRun
    ? null
    : writeFailureCache(config.projectRoot, buildFailureCache(config)).catch(
        (err: Error) =>
          config.debug && process.stderr.write(`# [qunitx] writeFailureCache: ${err.message}\n`),
      );
  if (config.debug) printFileTimings(fileTimes, config.projectRoot);

  if (config.after) {
    await runUserModule(`${process.cwd()}/${config.after}`, config.state.results.counter, 'after');
  }

  // Daemon mode: close the per-run shared server (if any) but never the browser
  // (the daemon owns it across runs). Throw DaemonRunError so the daemon's run
  // handler captures the exit code instead of hitting process.exit.
  if (config.state.daemon) {
    clearInterval(keepAlive);
    await closeWithGrace([
      sharedServer
        ?.close()
        .catch(
          (err: Error) =>
            config.debug && process.stderr.write(`# [qunitx] server.close: ${err.message}\n`),
        ),
    ]);
    throw new DaemonRunError(exitCode);
  }

  // First-time discoverability nudge for the daemon — only on local-mode runs that
  // took long enough to actually benefit. shouldShowDaemonHint() handles the rest of
  // the suppression matrix (CI / env opt-outs / TTY / sentinel).
  await maybePrintDaemonHint({ durationMs: process.uptime() * 1000 });

  // Flush stdout, shut down Chrome cleanly, then exit.
  // keepAlive holds the event loop open until this callback fires, at which point
  // process.exit() takes over — so clearInterval happens here, not earlier.
  // If the write callback never fires (theoretical), the unref'd exitTimer is the fallback.
  const exitTimer = setTimeout(() => process.exit(exitCode), STDOUT_FLUSH_GRACE_MS);
  exitTimer.unref();

  process.stdout.write('\n', async () => {
    clearTimeout(exitTimer);
    // keepAlive is cleared AFTER cleanup so the interval holds the event loop open
    // throughout, preventing premature drain if every close resolves instantly (e.g.
    // Chrome already dead) before proc.ref() takes effect inside shutdownPrelaunch.
    //
    // closeWithGrace bounds this race: Playwright's browser.close() can deadlock on
    // Firefox + Windows, leaving the CLI alive but silent until the test runner
    // SIGTERMs it ~60 s later. Best-effort cleanup, exit anyway.
    await closeWithGrace([
      failureCacheWrite,
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
      shutdownPrelaunch(),
    ]);
    clearInterval(keepAlive);
    process.exit(exitCode);
  });
}

export { run as default };

/**
 * Reads each HTML fixture file referenced by the config, classifies them as
 * dynamic (have qunitx tokens, get bundle-injection at request time) or static,
 * collects internal asset paths, and resolves the main HTML to inject the test
 * runtime into. Returns the populated `CachedContent` consumed by `run()` and
 * the daemon's `runOnce()`.
 */
async function buildCachedContent(config: Config, htmlPaths: string[]): Promise<CachedContent> {
  const htmlBuffers = await Promise.all(
    config.htmlPaths.map((htmlPath) => fs.readFile(htmlPath).catch(() => null)),
  );
  const htmlAssets = config.state.htmlAssets;
  const cachedContent = htmlPaths.reduce(
    (result, _htmlPath, index) => {
      const buffer = htmlBuffers[index];
      if (buffer === null) return result;
      const filePath = config.htmlPaths[index];
      const html = buffer.toString();

      if (isCustomTemplate(html)) {
        htmlAssets.dynamicContentHTMLs[filePath] = html;
        result.htmlPathsToRunTests.push(filePath.replace(config.projectRoot, ''));
      } else {
        console.log(
          '#',
          yellow(
            `WARNING: Static html file with no {{qunitxScript}} or handlebars-style tokens detected. Therefore ignoring ${filePath}`,
          ),
        );
        htmlAssets.staticHTMLs[filePath] = html;
      }

      findInternalAssetsFromHTML(html).forEach((key) => {
        htmlAssets.assets.add(
          normalizeInternalAssetPathFromHTML(config.projectRoot, key, filePath),
        );
      });

      return result;
    },
    {
      allTestCode: null,
      htmlPathsToRunTests: [],
    },
  );

  if (cachedContent.htmlPathsToRunTests.length === 0) {
    cachedContent.htmlPathsToRunTests = ['/'];
  }

  await resolveMainHTML(config.projectRoot, htmlAssets);
  return cachedContent;
}

/** Picks the page the test runtime is injected into, falling back to the bundled template. */
async function resolveMainHTML(projectRoot: string, htmlAssets: HtmlAssets): Promise<void> {
  const mainHTMLPath = Object.keys(htmlAssets.dynamicContentHTMLs)[0];
  if (mainHTMLPath) {
    htmlAssets.mainHTML = {
      filePath: mainHTMLPath,
      html: htmlAssets.dynamicContentHTMLs[mainHTMLPath],
    };
  } else {
    const html = await readTemplate('setup/tests.hbs');
    htmlAssets.mainHTML = { filePath: `${projectRoot}/test/tests.html`, html };
    // qunit.css (linked by the template) is served by the web server from the CLI's own embedded
    // copy — see the /node_modules/qunitx/vendor/qunit.css route in web-server.ts. It is no longer
    // copied out of the consumer's node_modules, so projects need not install `qunitx`.
  }
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
