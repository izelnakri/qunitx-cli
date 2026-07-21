import * as WebServer from './web-server.ts';
import { bindServerToPort } from './bind-server-to-port.ts';
import { findChrome } from '../chrome/find-chrome.ts';
import { CHROMIUM_ARGS } from '../chrome/chromium-args.ts';
import { prelaunchPromise, shutdownPrelaunch } from '../chrome/prelaunch.ts';
import { perfLog } from '../utils/perf-logger.ts';
import * as RunState from './run-state.ts';
import type { Browser } from 'playwright-core';
import type { HTTPServer } from '../servers/web.ts';
import type { Config, Connections } from '../types.ts';

// Playwright-core starts loading the moment run.js imports this module.
// browser.js is intentionally the first import in run.js so playwright-core
// starts loading before heavier deps (esbuild, chokidar) queue up I/O reads
// and saturate libuv's thread pool, which would delay the dynamic import resolution.
// chrome-prelaunch.ts (statically imported by cli.ts) already started Chrome pre-launch,
// so both race in parallel — Chrome is typically ready when playwright-core finishes.
const playwrightCorePromise = import('playwright-core');
perfLog('browser.js: playwright-core import started');

/**
 * Launches a browser for the given config.browser type.
 * For chromium: connects via CDP to the pre-launched Chrome (fast path) or falls
 * back to chromium.launch() if pre-launch failed.
 * For firefox/webkit: uses playwright's standard launch (requires `npx playwright install [browser]`).
 *
 * @param skipPrelaunch When true, bypasses the prelaunch CDP path entirely and goes
 * straight to a fresh chromium.launch(). Used by the daemon's crash-recovery path —
 * prelaunch is a one-shot startup optimization and recovery needs a fresh browser.
 * @returns {Promise<object>}
 */
export async function launch(config: Config, skipPrelaunch = false): Promise<Browser> {
  const browserName = config.browser || 'chromium';

  if (browserName === 'chromium') {
    const waitStart = Date.now();
    const [playwrightCore, prelaunch] = await Promise.all([
      playwrightCorePromise,
      skipPrelaunch ? Promise.resolve(null) : prelaunchPromise,
    ]);
    perfLog(
      `browser.js: playwright-core + prelaunch resolved in ${Date.now() - waitStart}ms, prelaunch:`,
      prelaunch?.cdpEndpoint ?? null,
    );

    if (prelaunch) {
      const connectStart = Date.now();
      try {
        const browser = await playwrightCore.chromium.connectOverCDP({
          endpointURL: prelaunch.cdpEndpoint,
          // Short timeout: if Chrome isn't CDP-ready within 5s (e.g. resource contention on
          // slow CI runners with many concurrent pre-launches), fall back to chromium.launch().
          timeout: 5000,
        });
        perfLog(`browser.js: connectOverCDP took ${Date.now() - connectStart}ms`);
        return browser;
      } catch {
        perfLog(
          `browser.js: connectOverCDP failed after ${Date.now() - connectStart}ms — falling back to chromium.launch()`,
        );
        await shutdownPrelaunch();
      }
    }

    // Pre-launch failed (Chrome not found, wrong version, resource contention, etc.) — fall back to normal launch.
    //
    // macOS: executablePath is left null so playwright-core uses its own chromium-headless-shell
    // (installed in CI via `playwright-core install chromium-headless-shell`). CHROME_BIN
    // (Google Chrome for Testing) is not used here because playwright-core unconditionally adds
    // --enable-unsafe-swiftshader, which crashes the ARM64 Chrome renderer on macOS CI VMs.
    // chromium-headless-shell is purpose-built for this and does not have that issue.
    const executablePath = process.platform !== 'darwin' ? await findChrome() : null;
    const launchOptions: Parameters<typeof playwrightCore.chromium.launch>[0] = {
      args: CHROMIUM_ARGS,
      headless: true,
      // Disable Playwright's async SIGTERM/SIGHUP handlers. When the CLI is killed by an
      // external signal (e.g. exec() timeout in tests), those handlers start an async browser
      // graceful-close that can hang indefinitely on CI, preventing the process from exiting
      // and blocking the test runner. With these disabled, Node.js's default signal behaviour
      // (synchronous process.exit) runs instead, and Playwright's synchronous exitHandler
      // (registered via process.on('exit')) still kills the browser correctly.
      handleSIGTERM: false,
      handleSIGHUP: false,
    };
    if (executablePath) launchOptions.executablePath = executablePath;
    return playwrightCore.chromium.launch(launchOptions);
  }

  const playwrightCore = await playwrightCorePromise;
  const launchOpts = {
    headless: !(config.open && config.watch),
    // See comment in the chromium fallback path above for why these are disabled.
    handleSIGTERM: false,
    handleSIGHUP: false,
  };
  // POSIX: a single launch attempt — no flake to absorb.
  if (process.platform !== 'win32') return playwrightCore[browserName].launch(launchOpts);
  // Windows-only retry for the Deno-compiled binary path: deno compile's
  // node:child_process shim intermittently fails with "The handle is invalid.
  // (os error 6)" when Playwright spawns firefox/webkit through
  // playwright-core's processLauncher. Chromium isn't affected — it goes
  // through our CDP pre-launch (chrome-prelaunch.ts) and never calls
  // child_process.spawn for the browser process. Remove this once upstream
  // Deno fixes their spawn shim for compiled binaries on Windows (denoland/deno#35994).
  try {
    return await playwrightCore[browserName].launch(launchOpts);
  } catch (err) {
    if (!/os error 6|handle is invalid/i.test((err as Error).message || '')) throw err;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return playwrightCore[browserName].launch(launchOpts);
  }
}

/**
 * Launches a Playwright browser (or reuses an existing one), starts the web server, and returns the page/server/browser connection object.
 * @returns {Promise<{server: object, browser: object, page: object}>}
 */
export async function setup(
  config: Config,
  existingBrowser: Browser | null = null,
  sharedServer: HTTPServer | null = null,
): Promise<Connections> {
  const setupStart = Date.now();

  // Daemon single-group fast path: reuse the persistent page from the slot.
  // The cleanup hook in run.ts re-stashes it when the run completes healthily;
  // listeners from the previous run are stripped here before fresh ones attach.
  // `!isClosed()` rejects pages explicitly closed AND also catches pages whose
  // browser context died (Playwright marks the page closed when the browser
  // disconnects). Browser-crash recovery in server.ts nulls the slot too, so
  // this is a belt-and-braces check.
  const slot = RunState.reusablePageSlot(config.state);
  const slotPage = slot?.page && !slot.page.isClosed() ? slot.page : null;
  if (slotPage) {
    slotPage.removeAllListeners('console');
    slotPage.removeAllListeners('pageerror');
    slot!.page = null;
  }

  const [server, browser, page] = await (async () => {
    if (sharedServer) {
      // Concurrent mode with shared server: skip per-group server setup and port binding.
      const newPage = slotPage ?? (await existingBrowser!.newPage());
      perfLog(`browser.js: newPage (shared server) took ${Date.now() - setupStart}ms`);
      return [sharedServer, existingBrowser!, newPage] as const;
    }

    const newServer = WebServer.setup(config);
    perfLog(`browser.js: WebServer.setup took ${Date.now() - setupStart}ms`);

    const activeBrowser = existingBrowser ?? (await launch(config));
    const pageStart = Date.now();
    // In headed watch mode (bare --open + --watch), Chrome is pre-launched without --headless=new
    // so it already has a blank default tab. Reuse that page instead of opening a new one —
    // otherwise the user sees the blank startup tab AND the new Playwright tab simultaneously.
    // For all other modes (headless, --open=<binary>, or non-watch), always create a fresh page.
    const isHeadedWatchMode = config.open === true && config.watch;
    const getPage = slotPage
      ? () => Promise.resolve(slotPage)
      : isHeadedWatchMode
        ? () => activeBrowser.contexts()[0]?.pages()[0] ?? activeBrowser.newPage()
        : () => activeBrowser.newPage();
    const [newPage] = await Promise.all([getPage(), bindServerToPort(newServer, config)]);
    perfLog(`browser.js: newPage + bindServerToPort took ${Date.now() - pageStart}ms`);
    return [newServer, activeBrowser, newPage] as const;
  })();

  // Firefox BiDi sends all object console args by handle (no inline value), so
  // arg.jsonValue() always fails for objects — even plain ones with no special types.
  // Pre-serialize objects to JSON strings in the browser before BiDi sees them:
  // strings are always sent inline, making arg.jsonValue() succeed.
  // Only applied to Firefox — Chrome CDP serialises objects natively.
  // Skip when the page came from the daemon slot: addInitScript appends to a
  // per-Page list that runs on every navigation, so re-adding here on each
  // reuse would double-serialise the next test run's console output.
  if (config.browser === 'firefox' && !slotPage) {
    await page.addInitScript(() => {
      const preSerialize = (arg: unknown): unknown => {
        if (arg === null || typeof arg !== 'object') return arg;
        try {
          return JSON.stringify(arg, (_key, v) => (v instanceof Date ? v.toISOString() : v));
        } catch {
          return String(arg);
        }
      };
      (['log', 'warn', 'error', 'info', 'debug'] as const).forEach((method) => {
        const orig = console[method].bind(console);
        console[method] = (...args: unknown[]) => orig(...args.map(preSerialize));
      });
    });
  }

  config.state.group.pendingConsoleHandlers = new Set();
  page.on('console', (msg) => {
    const type = msg.type();
    // Always surface warnings and errors so CI logs capture browser-side failures
    // without requiring --debug. Other log levels are debug-only to avoid noise.
    const alwaysShow = type === 'warning' || type === 'error';
    if (!alwaysShow && !config.debug) return;
    // Track each handler promise so callers can await all pending BiDi round-trips
    // before closing the browser/page. Without this, Firefox BiDi delivers console
    // events asynchronously after QUnit done, and arg.evaluate() round-trips fail
    // when the browser closes mid-flight, falling back to the useless "JSHandle@object".
    const handler = (async () => {
      try {
        const values = await Promise.all(msg.args().map((arg) => arg.jsonValue()));
        console.log(...values);
      } catch {
        console.log(msg.text());
      }
    })();
    config.state.group.pendingConsoleHandlers!.add(handler);
    handler.finally(() => config.state.group.pendingConsoleHandlers?.delete(handler));
  });
  page.on('pageerror', (error) => {
    console.error(error.toString());
    config.state.results.counter.failCount++;
  });

  return { server, browser, page };
}
