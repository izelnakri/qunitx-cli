import { setupWebServer } from './web-server.ts';
import { bindServerToPort } from './bind-server-to-port.ts';
import { findChrome } from '../utils/find-chrome.ts';
import { CHROMIUM_ARGS } from '../utils/chromium-args.ts';
import { prelaunchPromise } from '../utils/chrome-prelaunch.ts';
import { perfLog } from '../utils/perf-logger.ts';
import type { Browser } from 'playwright-core';
import type { HTTPServer } from '../servers/http.ts';
import type { Config, CachedContent, Connections } from '../types.ts';

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
 * @returns {Promise<object>}
 */
export async function launchBrowser(config: Config): Promise<Browser> {
  const browserName = config.browser || 'chromium';

  if (browserName === 'chromium') {
    const waitStart = Date.now();
    const [playwrightCore, prelaunch] = await Promise.all([
      playwrightCorePromise,
      prelaunchPromise,
    ]);
    perfLog(
      `browser.js: playwright-core + prelaunch resolved in ${Date.now() - waitStart}ms, prelaunch:`,
      prelaunch?.cdpEndpoint ?? null,
    );

    if (prelaunch) {
      const connectStart = Date.now();
      const browser = await playwrightCore.chromium.connectOverCDP({
        endpointURL: prelaunch.cdpEndpoint,
      });
      perfLog(`browser.js: connectOverCDP took ${Date.now() - connectStart}ms`);
      return browser;
    }

    // Pre-launch failed (Chrome not found, wrong version, etc.) — fall back to normal launch.
    const executablePath = await findChrome();
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
  return playwrightCore[browserName].launch({
    headless: !(config.open && config.watch),
    // See comment in the chromium fallback path above for why these are disabled.
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
}

/**
 * Launches a Playwright browser (or reuses an existing one), starts the web server, and returns the page/server/browser connection object.
 * @returns {Promise<{server: object, browser: object, page: object}>}
 */
export async function setupBrowser(
  config: Config,
  cachedContent: CachedContent,
  existingBrowser: Browser | null = null,
  sharedServer: HTTPServer | null = null,
): Promise<Connections> {
  const setupStart = Date.now();

  const [server, browser, page] = await (async () => {
    if (sharedServer) {
      // Concurrent mode with shared server: skip per-group server setup and port binding.
      const newPage = await existingBrowser!.newPage();
      perfLog(`browser.js: newPage (shared server) took ${Date.now() - setupStart}ms`);
      return [sharedServer, existingBrowser!, newPage] as const;
    }

    const newServer = setupWebServer(config, cachedContent);
    perfLog(`browser.js: setupWebServer took ${Date.now() - setupStart}ms`);

    const activeBrowser = existingBrowser ?? (await launchBrowser(config));
    const pageStart = Date.now();
    // In headed watch mode (bare --open + --watch), Chrome is pre-launched without --headless=new
    // so it already has a blank default tab. Reuse that page instead of opening a new one —
    // otherwise the user sees the blank startup tab AND the new Playwright tab simultaneously.
    // For all other modes (headless, --open=<binary>, or non-watch), always create a fresh page.
    const isHeadedWatchMode = config.open === true && config.watch;
    const getPage = isHeadedWatchMode
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
  if (config.browser === 'firefox') {
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

  config._pendingConsoleHandlers = new Set();
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
    config._pendingConsoleHandlers!.add(handler);
    handler.finally(() => config._pendingConsoleHandlers?.delete(handler));
  });
  page.on('pageerror', (error) => {
    console.error(error.toString());
    config.COUNTER.failCount++;
  });

  return { server, browser, page };
}

export { setupBrowser as default };
