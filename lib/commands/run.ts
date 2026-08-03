import * as Browser from '../setup/browser.ts';
import { shutdownPrelaunch } from '../chrome/prelaunch.ts';
import { HTTPServer } from '../web/index.ts';
import { bindServerToPort } from '../setup/bind-server-to-port.ts';
import * as WebServer from '../setup/web-server.ts';
import { openOutputInBrowser } from '../utils/open-output-in-browser.ts';
import fs from 'node:fs/promises';
import { normalize } from 'node:path';
import { availableParallelism } from 'node:os';
// node:timers returns Timer objects with .unref()/.ref() in both Node and Deno.
// The bare `setTimeout` global in Deno is the Web platform variant, which returns
// a number with no unref method.
import { setTimeout, setInterval, clearInterval } from 'node:timers';
import { blue, yellow } from '../utils/color.ts';
import {
  run as runInBrowser,
  buildTestBundle,
  buildAllGroupBundles,
  flushConsoleHandlers,
} from './run/tests-in-browser.ts';

import * as RunState from '../setup/run-state.ts';
import * as FileWatcher from '../setup/file-watcher.ts';
import { getChangedFsTree } from '../setup/get-changed-fs-tree.ts';
import { findInternalAssetsFromHTML } from '../utils/find-internal-assets-from-html.ts';
import { runUserModule } from '../utils/run-user-module.ts';
import { writeOutputStaticFiles } from '../setup/write-output-static-files.ts';
import * as TimeCounter from '../utils/time-counter.ts';
import * as Reporter from '../reporters/index.ts';
import { readTemplate } from '../utils/read-template.ts';
import { isCustomTemplate } from '../utils/html.ts';
import { closeWithGrace } from '../utils/close-with-grace.ts';
import * as Hint from './daemon/hint.ts';
import * as FailureCache from '../utils/failure-cache.ts';
import * as Coverage from '../coverage/index.ts';
import { isFilteredRun, describeActiveFilters } from '../selection/filter.ts';
import * as Timings from './run/timings.ts';
import { applyWatchLineTargets, resolveTargetedFiles, splitIntoGroups } from './run/grouping.ts';
import type { QUnitSelector } from '../selection/line-targets.ts';
import type { Config, Connections, HtmlAssets } from '../types.ts';
import { Task } from '../task/index.ts';

// Playwright navigation timeout for headed watch-mode reloads (not test execution).
const WATCH_NAV_TIMEOUT_MS = 5_000;
// setInterval period that keeps the event loop alive while Promise.allSettled runs.
const KEEP_ALIVE_INTERVAL_MS = 10_000;
// Daemon-only bound on the "connecting" phase (Browser.setup → newPage on the reused
// browser). newPage() is the one connecting step with no timeout — it only rejects once
// Playwright observes the transport close, which under load can lag a browser that died in
// the microsecond window after the pre-run liveness probe passed. Without a bound, that
// wedges the run on the 180s GROUP_TIMEOUT and hangs the client (no timeout of its own).
// 30s is orders of magnitude over a healthy connect (sub-second) yet well under the group
// deadline, so it only ever fires on a genuine wedge; the daemon then recovers for the next
// run. Local runs launch a fresh browser per invocation, so this race can't apply there.
const DAEMON_CONNECT_TIMEOUT_MS = 30_000;

/**
 * How a one-shot run ended. Everything a caller needs to decide what happens next, and nothing
 * about how it should be announced — {@link run} neither writes a summary nor exits.
 *
 * That is the point of the shape: it is what `cli.ts` turns into an exit code, what the daemon
 * ships back over its socket, and what the JS API builds its result from. Three consumers, one
 * return value, and no `process.exit` between them.
 *
 * ```ts
 * const outcome: RunOutcome = { exitCode: 1, durationMs: 1240 };
 * outcome.exitCode === 0; // false — at least one test failed, or a group rejected
 * ```
 */
export interface RunOutcome {
  /** `0` when every test passed, `1` for any failure, group rejection, or empty filtered run. */
  exitCode: number;
  /** Wall-clock duration of the test phase in milliseconds. */
  durationMs: number;
}

/**
 * A live watch session: the run's browser, server and file watchers, kept open.
 *
 * Returned rather than "the process stays alive and you figure it out", so a caller other than
 * the CLI — the JS API, a test of the watcher itself — can drive reruns and then shut the whole
 * thing down deterministically.
 *
 * ```ts
 * // Defined, not invoked: a real session owns a browser and a bound port.
 * async function restartOnce(session: WatchSession) {
 *   await session.rerun(); // same rerun the file watcher performs
 *   await session.close();
 * }
 * ```
 */
export interface WatchSession {
  /** The resolved config this session runs with; its `state` carries the live counters. */
  config: Config;
  /** The session's browser, page and HTTP server. */
  connections: Connections;
  /** Where the QUnit view is being served, e.g. `http://localhost:1234`. */
  url: string;
  /** Re-runs now, optionally scoped to `files`; resolves when that run finishes. */
  rerun(files?: string[]): Promise<void>;
  /** Stops the watchers and closes the browser and server. Idempotent. */
  close(): Promise<void>;
}

/**
 * Runs the whole suite once in headless Chrome and resolves with its {@link RunOutcome}.
 *
 * ```ts
 * import type { run } from './run.ts';
 * import type { Config } from '../types.ts';
 * // Defined, not invoked: launches Chrome and runs the whole suite.
 * async function runSuite(runTests: typeof run, config: Config) {
 *   const { exitCode } = await runTests(config); // returns; deciding what that means is the caller's
 *   return exitCode;
 * }
 * ```
 */
export async function run(config: Config): Promise<RunOutcome> {
  disableUnsupportedCoverage(config);

  // Kick off all I/O that doesn't need the HTML fixtures in parallel with resolveHtmlFixtures:
  //   Browser.launch: CDP connect to pre-launched Chrome (~30-50ms)
  //   Timings.read: reads tmp/test-timings.json (~2ms)
  //   resolveHtmlFixtures: reads HTML template from disk (~5-10ms)
  // Chrome is typically fully connected by the time resolveHtmlFixtures + splitIntoGroups resolve.
  // Daemon mode reuses its persistent browser; local runs launch their own.
  const daemonBrowser = config.state.daemon?.browser;
  const browserPromise = daemonBrowser ? Promise.resolve(daemonBrowser) : Browser.launch(config);
  const [, timings] = await Promise.all([
    resolveHtmlFixtures(config),
    Timings.read(config.projectRoot),
  ]);

  return await runConcurrentMode(config, timings, browserPromise);
}

/**
 * Starts a watch session: one browser, one page, every test file in a single bundle, behind an
 * HTTP server that stays up. Resolves once the initial run has finished and the watchers are
 * armed — the returned {@link WatchSession} is how the caller stops it again.
 *
 * ```ts
 * import type { watch } from './run.ts';
 * import type { Config } from '../types.ts';
 * // Defined, not invoked: launches Chrome and leaves it watching.
 * async function watchSuite(startWatching: typeof watch, config: Config) {
 *   const session = await startWatching(config);
 *   return session.url; // 'http://localhost:1234'
 * }
 * ```
 */
export async function watch(config: Config): Promise<WatchSession> {
  disableUnsupportedCoverage(config);
  // Load-bearing for the whole function: `runInBrowser`, the file watcher and the keyboard
  // shortcuts all branch on it, and a session started through the JS API arrives here with the
  // flag unset because nobody typed `--watch`.
  config.watch = true;
  await resolveHtmlFixtures(config);

  return await runWatchMode(config);
}

// Coverage is V8-precise-coverage over CDP, which only the chromium engine exposes. For
// firefox/webkit, warn once and disable so the rest of the pipeline treats it as off.
function disableUnsupportedCoverage(config: Config): void {
  if (!config.coverage || config.browser === 'chromium') return;
  Reporter.notice(config, {
    level: 'warning',
    message: `Warning: --coverage requires the chromium browser; skipping coverage for ${config.browser}.`,
  });
  config.coverage = false;
}

/**
 * WATCH MODE: one browser, one page, every test file in a single bundle, behind an HTTP server
 * that stays up so the QUnit view can be kept open. Reruns are driven by the file watcher; the
 * caller owns whatever else drives them (the CLI adds keyboard shortcuts) and owns shutting the
 * session down.
 */
async function runWatchMode(config: Config): Promise<WatchSession> {
  const build = config.state.group.build;
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
  // runInBrowser. The promise is stored on the group's build state so runInBrowser can
  // await it inside its own try/catch — errors surface as BundleErrors there, keeping
  // the watcher alive exactly as they would for a normal watch-mode build failure.
  // Suppress unhandled rejection: esbuild can fail (syntax error, missing file) before
  // Browser.setup completes. Without an eagerly-attached handler, Node.js detects the rejection during the
  // Promise.all window and crashes the process. runInBrowser awaits this promise inside
  // its own try/catch, so the rejection is handled — but only after Browser.setup resolves.
  const preBuildPromise = buildTestBundle(config);
  Task(preBuildPromise).ignore('pre-build rejection — re-awaited by runInBrowser');
  build.preBuildPromise = preBuildPromise;

  const [connections] = await Promise.all([
    Browser.setup(config),
    writeOutputStaticFiles(config, config.state.htmlAssets),
  ]);
  config.webServer = connections.server;

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
    await runUserModule(`${config.cwd}/${config.before}`, config, 'before');
  }

  // A run-narrowing flag (--only-failed / --changed / --since) scopes only the FIRST run in
  // watch mode. The full fsTree is left intact (Config.setup skips these filters in watch), so
  // `qa` and file-save reruns still see every file; `qf` / `ql` cover the rest interactively.
  let initialFilter: string[] | undefined;
  if (config.onlyFailed) {
    const failed = await FailureCache.filesToRerun(
      config.projectRoot,
      config.inputs.length > 0,
      config.fsTree,
    );
    if (failed && failed.length > 0) {
      initialFilter = failed;
      Reporter.notice(config, {
        level: 'info',
        message: blue(
          `qunitx --only-failed: first run scoped to ${failed.length} previously-failing test file${failed.length === 1 ? '' : 's'} — press "qa" to run all`,
        ),
      });
    } else {
      Reporter.notice(config, {
        level: 'info',
        message: blue(`qunitx --only-failed: no cached failures — running all tests`),
      });
    }
  } else if (config.changedSince) {
    // getChangedFsTree logs its own affected/fallback counts and returns the full tree on
    // fallback (cold metafile / git failure / blast-radius); scope only when it narrowed.
    const changed = Object.keys(await getChangedFsTree(config.fsTree, config, config.changedSince));
    if (changed.length < Object.keys(config.fsTree).length) {
      initialFilter = changed;
      if (changed.length > 0) {
        Reporter.notice(config, {
          level: 'info',
          message: blue(`qunitx --changed/--since: first run scoped — press "qa" to run all`),
        });
      }
    }
  }

  try {
    await runInBrowser(config, connections, initialFilter);
  } catch (error) {
    await closeWithGrace([connections.server?.close(), connections.browser?.close()]);
    throw error;
  }

  // In headed watch mode, navigate the Playwright page to the special-state HTML when the
  // initial run produced a build error or a 0-tests warning.
  // - Build error: page.goto was never called (runTestInsideHTMLFile bailed before navigation),
  //   so the page is still at about:blank.
  // - No-tests warning: page.goto WAS called (the page loaded normal QUnit HTML with 0 tests),
  //   but the no-tests fallback page is set only AFTER runTestInsideHTMLFile returns, so we must
  //   re-navigate so the route handler can now serve the warning page.
  if (isHeadedWatchMode && build.fallbackPage) {
    await Task(
      connections.page.goto(`http://localhost:${config.port}/`, {
        waitUntil: 'commit',
        timeout: WATCH_NAV_TIMEOUT_MS,
      }),
    ).ignore('headed watch-mode navigation to the fallback page');
  }

  // Every rerun — the watcher's, the CLI's keyboard shortcuts', the session's — goes through one
  // chain. Two runs sharing a page cannot overlap: the second's `page.goto` tears down the first's
  // JS context mid-run, and both then wait out the startup timeout. The watcher has an internal
  // guard for its OWN events, but nothing coordinated it with a rerun asked for from outside.
  const reruns = serializer();
  // The two rerun shapes are NOT interchangeable, and collapsing them broke the rename tests:
  //
  //   whole-suite  drops the cached bundle and rebuilds it, because the file set changed
  //   scoped       serves a freshly-built FILTERED bundle and leaves the full one alone
  //
  // A scoped rerun already compiles the files it was handed straight from disk, so it picks up
  // edits without the full rebuild — paying for one would just make every `add` slower.
  const rerun = (files?: string[]) =>
    reruns(() =>
      files
        ? runInBrowser(config, connections, files).then(() => {})
        : rebuildAndRun(config, connections),
    );

  const { ready: watcherReady, killFileWatchers } = FileWatcher.setup(
    config.testFileLookupPaths,
    config,
    async (event, file) => {
      if (event === 'addDir') return;
      if (['change', 'unlink', 'unlinkDir'].includes(event)) {
        // Ignore `change` events for files not yet in fsTree: fs.watch fires `change`
        // before `rename` (→ `add`) when a file is first created. The `add` event
        // will follow and trigger the correct filtered re-run.
        if (event === 'change' && !(file in config.fsTree)) return;
        // The cached bundle is dropped inside `rebuildAndRun`, when the rebuild starts — not
        // here, when the event arrives. Clearing on arrival nulled `allTestCode` out from under
        // a run already in flight, which then bailed out of its own post-navigation check having
        // registered nothing. Serialized reruns make "at the start of the work" the safe moment.
        if (config.debug) {
          Reporter.notice(config, {
            level: 'info',
            message: `Rerun triggered: ${event} → ${file.replace(`${config.projectRoot}/`, '')}`,
          });
        }
        return await rerun();
      }
      if (config.debug) {
        Reporter.notice(config, {
          level: 'info',
          message: `Rerun triggered: ${event} → ${file.replace(`${config.projectRoot}/`, '')}`,
        });
      }
      await rerun([file]);
    },
    async (_path, _event) => {
      connections.server.publish('refresh');
      // In headed watch mode the Playwright page IS the visible browser (navigator.webdriver=true
      // means it ignores the WS 'refresh' message). Navigate it directly after a build error
      // or a 0-tests warning so it shows the correct HTML rather than stale test results.
      if (isHeadedWatchMode && build.fallbackPage) {
        await Task(
          connections.page.goto(`http://localhost:${config.port}/`, {
            waitUntil: 'commit',
            timeout: WATCH_NAV_TIMEOUT_MS,
          }),
        ).ignore('headed watch-mode re-navigation after a rebuild');
      }
    },
  );
  await watcherReady;

  return {
    config,
    connections,
    url: `http://localhost:${config.port}`,
    // Rebuilds first, like the watcher's own change path: a caller asking for a rerun means
    // "run what is on disk now", and re-serving the cached bundle would answer with what was on
    // disk when the session started.
    rerun,
    close: () => closeSession(connections, killFileWatchers),
  };
}

/**
 * A one-at-a-time queue for work that cannot overlap.
 *
 * Each call waits for the previous one to settle — succeed or fail — and resolves or rejects
 * with its own outcome. A rejected run must not poison the queue for the next one, which is why
 * the stored tail swallows while the returned promise does not.
 */
function serializer(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();

  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.then(
      () => {},
      () => {},
    );

    return next;
  };
}

/**
 * Drops the cached bundles, starts a rebuild, and runs — the rerun every path through watch mode
 * performs.
 *
 * The build is kicked off rather than awaited so it races Chrome's navigation: `runInBrowser`
 * picks the promise up from `preBuildPromise` and the `/tests.js` route awaits it before serving,
 * which is what lets the two overlap. The rejection is pre-ignored because it is re-awaited
 * inside `runInBrowser`'s own try/catch, and an esbuild failure between here and there would
 * otherwise reach Node as an unhandled rejection and take the watch process down.
 */
function rebuildAndRun(config: Config, connections: Connections): Promise<void> {
  const build = config.state.group.build;
  RunState.clearBundles(build);
  const rebuild = buildTestBundle(config);
  Task(rebuild).ignore('watch rebuild rejection — re-awaited by runInBrowser');
  build.preBuildPromise = rebuild;

  return runInBrowser(config, connections).then(() => {});
}

/**
 * Stops a watch session's watchers and closes its browser and server. Bounded by
 * `closeWithGrace`, and safe to call twice — every step tolerates an already-closed handle.
 */
async function closeSession(
  connections: Connections,
  killFileWatchers: () => unknown,
): Promise<void> {
  killFileWatchers();
  await closeWithGrace([
    Task(connections.server?.close()).ignore('watch session server.close'),
    Task(connections.page?.close()).ignore('watch session page.close'),
    Task(connections.browser?.close()).ignore('watch session browser.close'),
    shutdownPrelaunch(),
  ]);
}

/**
 * CONCURRENT MODE: the one-shot batch run. Files are split across groups, each group getting its
 * own page inside one shared browser so esbuild time hides behind Chrome start-up. Reporting,
 * cache persistence and cleanup all happen here; the exit code is returned, not applied.
 */
async function runConcurrentMode(
  config: Config,
  timings: Record<string, number> | null,
  browserPromise: Promise<Awaited<ReturnType<typeof Browser.launch>>>,
): Promise<RunOutcome> {
  const build = config.state.group.build;
  // CONCURRENT MODE: split test files across N groups = availableParallelism().
  // All group bundles are built while Chrome is starting up, so esbuild time
  // is hidden behind the ~1.2s Chrome launch. Each group then gets its own
  // HTTP server and Playwright page inside one shared browser instance.
  const allFiles = Object.keys(config.fsTree);
  // Empty fsTree (e.g. --changed filtered out every test, or the inputs matched no files): emit
  // a clean TAP plan and report success. The downstream group/build pipeline assumes ≥1 file and
  // would crash on undefined groupConfigs[0].
  if (allFiles.length === 0) {
    Reporter.runStart(config, { fileCount: 0, groupCount: 0 });
    // The daemon owns its browser across runs and must keep it; a local run owns this one.
    if (!config.state.daemon) {
      await closeWithGrace([(await browserPromise).close(), shutdownPrelaunch()]);
    }
    return { exitCode: 0, durationMs: 0 };
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
  // Shared with every group config below; RunState.reusablePageSlot() reads it to decide page reuse.
  config.state.groupCount = groupCount;

  // All run accumulators — counter, failure sets, coverage — are cleared here, on the parent,
  // BEFORE the group configs are spread off it below. The spread copies `state` by reference, so
  // every group then adds into these same objects: TAP numbers stay globally sequential, failures
  // land in one set, and the coverage report covers the whole run rather than one group's slice.
  RunState.reset(config.state.results, !!config.coverage);
  config.state.group.lastRanFiles = allFiles;

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
    state: {
      ...config.state,
      group: {
        ...RunState.newGroup(i, selectors),
        groupMode: true,
        // The parent resolved these from the HTML fixtures before any group existed; each group
        // starts from that list and the shared-server branch below rewrites it to /group-{i}/.
        build: {
          ...RunState.newGroup().build,
          htmlPathsToRunTests: [...build.htmlPathsToRunTests],
        },
      },
    },
  }));

  // One shared HTTPServer for all groups (routed by /group-{i}/ prefix) when using the
  // default '/' HTML path. Falls back to per-group servers for custom HTML templates.
  const sharedServer =
    groupCount > 1 && build.htmlPathsToRunTests[0] === '/' && build.htmlPathsToRunTests.length === 1
      ? (() => {
          const s = new HTTPServer();
          WebServer.setupGroupWSHandler(s, groupConfigs);
          groupConfigs.forEach((gc) => WebServer.registerGroupRoutes(s, gc));
          WebServer.registerSharedStaticHandler(s, groupConfigs);
          return s;
        })()
      : null;

  Reporter.runStart(config, { fileCount: allFiles.length, groupCount });

  // Build all group bundles and write static files while the browser is starting up.
  // Bind the shared server's port in the same parallel window when active.
  const [browser] = await Promise.all([
    browserPromise!,
    sharedServer
      ? bindServerToPort(sharedServer, config).then(() =>
          groupConfigs.forEach((gc, i) => {
            gc.port = config.port;
            gc.state.group.build.htmlPathsToRunTests = [`/group-${i}/`];
          }),
        )
      : Promise.resolve(),
    Promise.all([
      groupCount > 1 ? buildAllGroupBundles(groupConfigs) : buildTestBundle(groupConfigs[0]),
      Promise.all(groupConfigs.map((gc) => writeOutputStaticFiles(gc, gc.state.htmlAssets))),
    ]),
  ]);

  // Open immediately after static files are ready — no need to wait for tests to finish.
  if (config.open) {
    void openOutputInBrowser(config);
  }
  const timer = TimeCounter.start();
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
        const connectWork = Browser.setup(groupConfig, browser, sharedServer);
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
          await runUserModule(`${config.cwd}/${config.before}`, groupConfig, 'before');
        }

        try {
          await runInBrowser(groupConfig, connections);
        } finally {
          await flushConsoleHandlers(
            groupConfig.state.group.pendingConsoleHandlers,
            connections.page,
          );
          // Daemon single-group fast path: stash the page on the slot for the next run instead
          // of closing it (saves ~70-130ms of newPage cost per warm run). Mid-page state is
          // dropped by the next run's page.goto(testUrl), which destroys the JS context.
          // RunState.reusablePageSlot() withholds the slot outside single-group daemon runs, and a
          // disconnected page falls through to close.
          const pageSlot = RunState.reusablePageSlot(groupConfig.state);
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
    (code, result) => {
      // `reason` only exists on the rejected arm of the union, so narrow before reading it.
      if (result.status !== 'rejected') return code;
      // Raw and stderr-only: a rejected group's reason is an Error whose stack IS the diagnostic,
      // and un-prefixed multi-line text on stdout would corrupt the TAP document.
      Reporter.notice(config, {
        level: 'error',
        raw: true,
        stream: 'error',
        message: `${(result.reason as Error)?.stack ?? String(result.reason)}\n`,
      });
      return 1;
    },
    config.state.results.counter.failCount > 0 ? 1 : 0,
  );

  if (config.state.results.counter.testCount === 0 && exitCode === 0) {
    if (isFilteredRun(config)) {
      // A filter matching nothing is a typo, not a green run — every neighbouring runner
      // fails here, and passing CI on a mistyped -t is the worst outcome available.
      Reporter.notice(config, {
        level: 'warning',
        message: `No tests matched ${describeActiveFilters(config)}`,
      });
      exitCode = 1;
    } else {
      const fileWord = allFiles.length === 1 ? 'file' : 'files';
      Reporter.notice(config, {
        level: 'warning',
        message: `Warning: 0 tests registered — no QUnit test cases found in ${allFiles.length} ${fileWord}`,
      });
    }
  }

  const durationMs = timer.stop();
  await Reporter.runEnd(config, { durationMs });

  if (config.coverage) await Coverage.Report.write(config, allFiles);

  // A test-level filter (-t/-m/line target) makes both caches lie: a file that ran 1 of its
  // 30 tests records ~1/30th of its wall time, which mis-packs every future full run, and its
  // failure set is only the matched subset. File-level narrowing (--only-failed/--changed) is
  // fine — those still run whole files.
  const filteredRun = isFilteredRun(config);
  const fileTimes = Timings.compute(
    groups.map((group) => group.files),
    weights,
    wallTimes,
  );
  if (!filteredRun) {
    Task(Timings.persist(fileTimes, config.projectRoot)).ignore('Timings.persist');
  }
  // Persist this run's failures for the next `--only-failed`. An empty set (all green) is
  // written too, so a passing re-run clears the cache. Awaited on the exit path below (unlike
  // timings, which tolerate loss) so a slow filesystem can't lose the cache to process.exit.
  const failureCacheWrite = filteredRun
    ? null
    : Task(FailureCache.write(config.projectRoot, FailureCache.build(config))).ignore(
        'FailureCache.write',
      );
  if (config.debug) Timings.print(fileTimes, config.projectRoot);

  if (config.after) {
    await runUserModule(`${config.cwd}/${config.after}`, config.state.results.counter, 'after');
  }

  // Daemon mode: close the per-run shared server (if any) but never the browser — the daemon
  // owns it across runs, and the next run reuses it.
  if (config.state.daemon) {
    await closeWithGrace([Task(sharedServer?.close()).ignore('server.close')]);
    clearInterval(keepAlive);
    return { exitCode, durationMs };
  }

  // First-time discoverability nudge for the daemon — only on local-mode runs that
  // took long enough to actually benefit. shouldShowDaemonHint() handles the rest of
  // the suppression matrix (CI / env opt-outs / TTY / sentinel).
  await Hint.maybePrint({ durationMs: process.uptime() * 1000 });

  // Cleanup happens here, before returning, rather than inside a `process.stdout.write` drain
  // callback racing an unref'd exit timer. The old shape existed because this function ended the
  // process; now that the caller does, "finish cleaning up, then hand back the outcome" is both
  // simpler and stricter — the failure cache can no longer be lost to an exit that fires first.
  //
  // keepAlive is cleared AFTER cleanup so the interval holds the event loop open throughout,
  // preventing a premature drain if every close resolves instantly (e.g. Chrome already dead)
  // before proc.ref() takes effect inside shutdownPrelaunch. closeWithGrace bounds the other
  // side: Playwright's browser.close() can deadlock on Firefox + Windows.
  await closeWithGrace([
    failureCacheWrite,
    Task(sharedServer?.close()).ignore('server.close'),
    Task(browser.close()).ignore('browser.close'),
    shutdownPrelaunch(),
  ]);
  clearInterval(keepAlive);

  return { exitCode, durationMs };
}

/**
 * Reads each HTML fixture file referenced by the config, classifies them as dynamic (have qunitx
 * tokens, get bundle-injection at request time) or static, collects internal asset paths, and
 * resolves the main HTML the test runtime is injected into. Populates `state.htmlAssets` and the
 * run's `htmlPathsToRunTests`; both are read by `run()` and the daemon's `runOnce()`.
 */
async function resolveHtmlFixtures(config: Config): Promise<void> {
  const htmlBuffers = await Promise.all(
    config.htmlPaths.map((htmlPath) => fs.readFile(htmlPath).catch(() => null)),
  );
  const htmlAssets = config.state.htmlAssets;
  const build = config.state.group.build;
  config.htmlPaths.reduce((result, _htmlPath, index) => {
    const buffer = htmlBuffers[index];
    if (buffer === null) return result;
    const filePath = config.htmlPaths[index];
    const html = buffer.toString();

    if (isCustomTemplate(html)) {
      htmlAssets.dynamicContentHTMLs[filePath] = html;
      result.htmlPathsToRunTests.push(filePath.replace(config.projectRoot, ''));
    } else {
      Reporter.notice(config, {
        level: 'warning',
        message: yellow(
          `WARNING: Static html file with no {{qunitxScript}} or handlebars-style tokens detected. Therefore ignoring ${filePath}`,
        ),
      });
      htmlAssets.staticHTMLs[filePath] = html;
    }

    findInternalAssetsFromHTML(html).forEach((key) => {
      htmlAssets.assets.add(normalizeInternalAssetPathFromHTML(config.projectRoot, key, filePath));
    });

    return result;
  }, build);

  if (build.htmlPathsToRunTests.length === 0) {
    build.htmlPathsToRunTests = ['/'];
  }

  await resolveMainHTML(config.projectRoot, htmlAssets);
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
