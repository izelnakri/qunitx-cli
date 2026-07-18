import { setupBrowser, launchBrowser } from '../setup/browser.ts';
import { shutdownPrelaunch } from '../utils/chrome-prelaunch.ts';
import { HTTPServer } from '../servers/web.ts';
import { bindServerToPort } from '../setup/bind-server-to-port.ts';
import {
  registerGroupRoutes,
  setupGroupWSHandler,
  registerSharedStaticHandler,
} from '../setup/web-server.ts';
import { openOutputInBrowser } from '../utils/open-output-in-browser.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
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
  RunCompleted,
} from './run/tests-in-browser.ts';
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
import { maybePrintDaemonHint } from '../utils/daemon-hint.ts';
import {
  writeFailureCache,
  buildFailureCache,
  resolveOnlyFailedFiles,
} from '../utils/failure-cache.ts';
import { writeCoverageReport } from '../coverage/report.ts';
import { isFilteredRun, describeFilter } from '../utils/qunit-filter.ts';
import { resolveLineTargets } from '../utils/line-targets.ts';
import type { QUnitSelector } from '../utils/line-targets.ts';
import type { Config, CachedContent } from '../types.ts';

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
  const browserPromise = config._daemonBrowser
    ? Promise.resolve(config._daemonBrowser)
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
      writeOutputStaticFiles(config, cachedContent),
    ]);
    config.webServer = connections.server;
    // Keyboard shortcuts put stdin in raw mode and exit the process on Ctrl-C — a terminal
    // affordance, not a library one. Embedded watch sessions drive reruns through the API.
    if (!config._embedded) setupKeyboardEvents(config, cachedContent, connections);

    // Explicitly close the HTTP server on SIGTERM before the process exits. This ensures
    // the port is reclaimed by application code (not as a side effect of OS process cleanup),
    // guaranteeing the port is free from the moment waitpid() returns in the parent process.
    // Without this, macOS can lag a few ms between waitpid() and socket reclamation, making
    // the port appear in-use immediately after the child exits.
    // Note: on Windows child.kill('SIGTERM') calls TerminateProcess() so this handler never
    // runs there — but TerminateProcess() is fully synchronous so the race doesn't exist on
    // Windows anyway. Exit with 143 (128 + SIGTERM) to preserve the conventional exit code.
    // Embedded watch sessions skip this: installing a process-wide signal handler that exits
    // is exactly the kind of ambient effect a library must not have. `session.close()` is the
    // API's teardown, and the host owns its own signal handling.
    if (!config._embedded) {
      process.once('SIGTERM', () => {
        closeWithGrace([connections.server.close()]).finally(() => process.exit(EXIT_CODE_SIGTERM));
      });
    }

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
      await runUserModule(`${process.cwd()}/${config.before}`, config, 'before', config._embedded);
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
      const { ready: watcherReady, killFileWatchers } = setupFileWatchers(
        config.testFileLookupPaths,
        config,
        async (event, file) => {
          if (event === 'addDir') return;
          config._embeddedOnChange?.(file);
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
      // The CLI ends a watch session by exiting the process, so it never needed to unwind one.
      // An embedded session does: `session.close()` calls this to stop the watchers and close
      // the browser and server it opened.
      if (config._embedded) {
        config._embeddedTeardown = async () => {
          killFileWatchers();
          await closeWithGrace([connections.server?.close(), connections.browser?.close()]);
        };
      }
    }

    // The banner advertises keyboard shortcuts, which embedded sessions do not install.
    if (!config._embedded) logWatcherAndKeyboardShortcutInfo(config, connections.server);
  } else {
    // CONCURRENT MODE: split test files across N groups = availableParallelism().
    // All group bundles are built while Chrome is starting up, so esbuild time
    // is hidden behind the ~1.2s Chrome launch. Each group then gets its own
    // HTTP server and Playwright page inside one shared browser instance.
    const allFiles = Object.keys(config.fsTree);
    // Empty fsTree (e.g. --changed filtered out every test, or the inputs
    // matched no files): emit a clean TAP plan and exit 0. The downstream
    // group/build pipeline assumes ≥1 file and would crash on undefined
    // groupConfigs[0]. In daemon mode, throw RunCompleted so the daemon's
    // run handler closes the run cleanly and stays alive for the next call.
    if (allFiles.length === 0) {
      reportRunStart(config, { fileCount: 0, groupCount: 0 });
      if (config._daemonMode) throw new RunCompleted(0);
      if (!config.watch) {
        const browser = config._daemonBrowser ? null : await browserPromise!;
        await closeWithGrace([browser?.close(), shutdownPrelaunch()]);
        if (config._embedded) throw new RunCompleted(0);
        return process.exit(0);
      }
      return;
    }
    // Line-targeted files run as their own single-file groups, each carrying its own selectors.
    // A group is one page with one QUnit config, so this is what lets `a.ts#34 b.ts` mean "the
    // one test in a.ts, all of b.ts" — a shared page could only express one filter for both.
    const targeted = await resolveLineTargetGroups(config, allFiles);
    const untargeted = allFiles.filter((file) => !targeted.some((group) => group.file === file));
    const untargetedGroupCount = Math.max(
      1,
      Math.min(untargeted.length, availableParallelism() - targeted.length),
    );
    const { groups: untargetedGroups, weights } = untargeted.length
      ? await splitIntoGroups(untargeted, untargetedGroupCount, timings ?? {})
      : { groups: [] as string[][], weights: new Map<string, number>() };
    const groups = [...targeted.map((group) => [group.file]), ...untargetedGroups];
    const groupSelectors = [
      ...targeted.map((group) => group.selectors),
      ...untargetedGroups.map(() => undefined),
    ];
    const groupCount = groups.length;

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
    // Fresh failure-cache accumulators, shared by reference into every group config below (like
    // COUNTER) so all groups add into one set. Reset here so a run never inherits stale failures.
    config._failedTestFiles = new Set();
    config._failedTests = [];

    // Shared reporter/coverage accumulators. Set on the parent config BEFORE the group
    // configs are spread off it, so every group pushes into the same collector and the
    // final report covers the whole run (mirrors how COUNTER is shared above).
    config._coverageCollector = config.coverage ? new Map() : null;

    const groupConfigs = groups.map((groupFiles, i) => ({
      ...config,
      // Per-group dedup map for the testEnd handler — see
      // Config._testEndCounts. Each group's COUNTER bucket is shared via the
      // parent `config`, but the dedup state is per-group so a duplicate
      // testEnd in group A doesn't accidentally suppress the legitimate first
      // testEnd of the same name in group B. (Two groups CAN legitimately
      // share a fullName when they bundle different files that happen to
      // register tests with the same module/test names — the dedup key is
      // intra-group.)
      _testEndCounts: new Map<string, number>(),
      _qunitSelectors: groupSelectors[i],
      fsTree: Object.fromEntries(groupFiles.map((filePath) => [filePath, config.fsTree[filePath]])),
      // Single group keeps the root output dir for backward-compatible file paths.
      output: groupCount === 1 ? config.output : `${config.output}/group-${i}`,
      // Page reuse is single-group only: in concurrent group mode group 0 would
      // otherwise drain `slot.page` (setupBrowser consumes it) without re-stashing
      // (cleanup's `groupCount === 1` guard rejects), leaving the slot empty for
      // the next single-file run. Withhold the slot here so the warm page survives
      // a transient multi-file invocation untouched.
      _daemonPageSlot: groupCount === 1 ? config._daemonPageSlot : undefined,
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
          const connectWork = setupBrowser(
            groupConfig,
            groupCachedContents[i],
            browser,
            sharedServer,
          );
          // Daemon runs reuse a persistent browser; bound the connect so a handle that
          // died just after the pre-run probe fails fast here (recovered next run) instead
          // of wedging until GROUP_TIMEOUT. See DAEMON_CONNECT_TIMEOUT_MS.
          const connections = config._daemonMode
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
            await runUserModule(
              `${process.cwd()}/${config.before}`,
              groupConfig,
              'before',
              config._embedded,
            );
          }

          try {
            await runTestsInBrowser(groupConfig, groupCachedContents[i], connections);
          } finally {
            await flushConsoleHandlers(groupConfig._pendingConsoleHandlers, connections.page);
            // Daemon single-group fast path: stash the page on the slot for the
            // next run instead of closing it (saves ~70-130ms of newPage cost
            // per warm run). Mid-page state is dropped by the next run's
            // page.goto(testUrl), which destroys the JS context. Group mode
            // (groupCount > 1) and any disconnected page fall through to close.
            const reusePage =
              groupCount === 1 &&
              groupConfig._daemonPageSlot &&
              connections.page &&
              !connections.page.isClosed();
            if (reusePage) groupConfig._daemonPageSlot!.page = connections.page;
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
      config.COUNTER.failCount > 0 ? 1 : 0,
    );

    if (config.COUNTER.testCount === 0 && exitCode === 0) {
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
    // matched nothing. Embedded runs leave the host's exit code alone — the caller gets the
    // code on the returned result and decides what it means for their process.
    if (!config._embedded) process.exitCode = exitCode;

    await reportRunEnd(config, { durationMs: TIME_COUNTER.stop() });

    if (config.coverage) await writeCoverageReport(config, allFiles);

    // A test-level filter (-t/-m/line target) makes both caches lie: a file that ran 1 of its
    // 30 tests records ~1/30th of its wall time, which mis-packs every future full run, and its
    // failure set is only the matched subset. File-level narrowing (--only-failed/--changed) is
    // fine — those still run whole files.
    const filteredRun = isFilteredRun(config);
    const fileTimes = computeFileTimes(groups, weights, wallTimes);
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
      await runUserModule(
        `${process.cwd()}/${config.after}`,
        config.COUNTER,
        'after',
        config._embedded,
      );
    }

    // Daemon mode: close the per-run shared server (if any) but never the browser
    // (the daemon owns it across runs). Throw RunCompleted so the daemon's run
    // handler captures the exit code instead of hitting process.exit.
    if (config._daemonMode) {
      clearInterval(keepAlive);
      await closeWithGrace([
        sharedServer
          ?.close()
          .catch(
            (err: Error) =>
              config.debug && process.stderr.write(`# [qunitx] server.close: ${err.message}\n`),
          ),
      ]);
      throw new RunCompleted(exitCode);
    }

    // Embedded (JS API): same teardown as the CLI path below, minus the stdout flush (the
    // host process keeps running) and the process.exit. The browser IS closed here — unlike
    // daemon mode, an embedded run launched its own and owns it.
    if (config._embedded) {
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
      throw new RunCompleted(exitCode);
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
}

export { readTimingCache, computeFileTimes, buildCachedContent };
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
    // qunit.css (linked by the template) is served by the web server from the CLI's own embedded
    // copy — see the /node_modules/qunitx/vendor/qunit.css route in web-server.ts. It is no longer
    // copied out of the consumer's node_modules, so projects need not install `qunitx`.
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
/**
 * Watch-mode line targets: narrow fsTree to the targeted files and apply their selectors for the
 * whole session.
 *
 * Watch is one page with one QUnit config, so a page-global selector set would filter every OTHER
 * file's tests down to nothing on the next save — the per-file scoping concurrent mode gets from
 * one-group-per-file has nowhere to live here. Narrowing fsTree keeps the selectors true for
 * everything loaded, at the cost of dropping untargeted inputs; those are named rather than
 * silently watched-but-never-run. `qa` clears the selectors to run everything still watched.
 */
async function applyWatchLineTargets(config: Config): Promise<void> {
  const allFiles = Object.keys(config.fsTree);
  const targeted = await resolveLineTargetGroups(config, allFiles);
  if (targeted.length === 0) return;

  const targetedFiles = new Set(targeted.map((group) => group.file));
  const dropped = allFiles.filter((file) => !targetedFiles.has(file));
  config.fsTree = Object.fromEntries([...targetedFiles].map((file) => [file, config.fsTree[file]]));
  config._qunitSelectors = targeted.flatMap((group) => group.selectors);
  if (dropped.length > 0) {
    console.log(
      '#',
      blue(
        `qunitx: --watch with a line target runs only the targeted file${targetedFiles.size === 1 ? '' : 's'} — ${dropped.length} other file${dropped.length === 1 ? '' : 's'} excluded from this session`,
      ),
    );
  }
  console.log('#', blue(`qunitx: press "qa" to run every test in the watched file(s)`));
}

/**
 * Resolves each `file#34` input into the selectors for that file, dropping targets whose file is
 * no longer in the run (a glob, `--changed` or `--only-failed` may have filtered it out) and
 * those that resolved to nothing — both fall back to running the file whole, which is what a
 * null `selectors` means. Every warning is surfaced; a line target that quietly did not narrow
 * is worse than one that says so.
 */
async function resolveLineTargetGroups(
  config: Config,
  allFiles: string[],
): Promise<Array<{ file: string; selectors: QUnitSelector[] }>> {
  const entries = Object.entries(config.lineTargets ?? {}).filter(([file]) =>
    allFiles.includes(file),
  );
  const resolved = await Promise.all(
    entries.map(async ([file, lines]) => {
      const { selectors, warnings } = await resolveLineTargets(
        file,
        lines,
        // Forward slashes in the warning regardless of OS — it echoes the `path#line` the user
        // typed, and they typed '/'. path.relative yields '\' on Windows.
        path.relative(config.projectRoot, file).replaceAll('\\', '/'),
      );
      warnings.forEach((warning) => console.log('#', blue(`qunitx: ${warning}`)));

      return selectors ? { file, selectors } : null;
    }),
  );

  return resolved.filter((group) => group !== null);
}

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
