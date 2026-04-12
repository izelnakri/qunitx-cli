import { setupWebServer } from './web-server.ts';
import { bindServerToPort } from './bind-server-to-port.ts';
import { findChrome } from '../utils/find-chrome.ts';
import { CHROMIUM_ARGS } from '../utils/chromium-args.ts';
import { earlyBrowserPromise } from '../utils/early-chrome.ts';
import { perfLog } from '../utils/perf-logger.ts';
import type { Browser } from 'playwright-core';
import type { Config, CachedContent, Connections } from '../types.ts';

// Playwright-core starts loading the moment run.js imports this module.
// browser.js is intentionally the first import in run.js so playwright-core
// starts loading before heavier deps (esbuild, chokidar) queue up I/O reads
// and saturate libuv's thread pool, which would delay the dynamic import resolution.
// early-chrome.ts (statically imported by cli.ts) already started Chrome pre-launch,
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
    const [playwrightCore, earlyChrome] = await Promise.all([
      playwrightCorePromise,
      earlyBrowserPromise,
    ]);
    perfLog(
      `browser.js: playwright-core + earlyChrome resolved in ${Date.now() - waitStart}ms, earlyChrome:`,
      earlyChrome?.cdpEndpoint ?? null,
    );

    if (earlyChrome) {
      const connectStart = Date.now();
      const browser = await playwrightCore.chromium.connectOverCDP({
        endpointURL: earlyChrome.cdpEndpoint,
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
): Promise<Connections> {
  const setupStart = Date.now();
  const [server, resolvedExistingBrowser] = await Promise.all([
    setupWebServer(config, cachedContent),
    Promise.resolve(existingBrowser),
  ]);
  perfLog(`browser.js: setupWebServer took ${Date.now() - setupStart}ms`);

  const browser = resolvedExistingBrowser || (await launchBrowser(config));

  const pageStart = Date.now();
  const [page] = await Promise.all([browser.newPage(), bindServerToPort(server, config)]);
  perfLog(`browser.js: newPage + bindServerToPort took ${Date.now() - pageStart}ms`);

  await page.addInitScript(() => {
    window.IS_PLAYWRIGHT = true;
  });

  page.on('console', async (msg) => {
    const type = msg.type();
    // Always surface warnings and errors so CI logs capture browser-side failures
    // without requiring --debug. Other log levels are debug-only to avoid noise.
    const alwaysShow = type === 'warning' || type === 'error';
    if (!alwaysShow && !config.debug) return;
    try {
      const values = await Promise.all(msg.args().map((arg) => arg.jsonValue()));
      console.log(...values);
    } catch {
      console.log(msg.text());
    }
  });
  page.on('pageerror', (error) => {
    console.log(error.toString());
    console.error(error.toString());
  });

  return { server, browser, page };
}

export { setupBrowser as default };
