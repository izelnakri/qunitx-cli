import findChrome from './find-chrome.ts';
import preLaunchChrome from './pre-launch-chrome.ts';
import CHROMIUM_ARGS from './chromium-args.ts';
import { perfLog } from './perf-logger.ts';

// This module is statically imported by cli.ts so its module-level code runs
// at the very start of the process — before the IIFE, before playwright-core loads.
// For run commands only, Chrome is spawned immediately via CDP so it is ready
// (or nearly ready) by the time playwright-core finishes loading (~500ms later).
// For help/init/generate, nothing is spawned and this module costs ~0ms.

const NON_RUN_COMMANDS = new Set(['help', 'h', 'p', 'print', 'new', 'n', 'g', 'generate', 'init']);
const isRunCommand = Boolean(process.argv[2]) && !NON_RUN_COMMANDS.has(process.argv[2]);
const { browserFromArgv, openFromArgv, watchFromArgv } = process.argv.reduce(
  (flags, arg) => {
    if (arg.startsWith('--browser=')) flags.browserFromArgv = arg.slice(10);
    else if (arg === '--open' || arg === '-o') flags.openFromArgv = true;
    else if (arg === '--watch' || arg === '-w') flags.watchFromArgv = true;
    return flags;
  },
  { browserFromArgv: 'chromium', openFromArgv: false, watchFromArgv: false },
);
// With --open --watch, Chrome is left alive after qunitx exits so the visible browser window persists.
// With --open alone, qunitx exits after tests complete; the detached browser is opened separately.
const openWatchMode = openFromArgv && watchFromArgv;

// Stored so the process.on('exit') safety net and shutdownEarlyBrowser() can reach Chrome.
let earlyChrome: import('../types.ts').EarlyChrome | null = null;

if (!openWatchMode) {
  process.on('exit', () => {
    if (!earlyChrome) return;
    // Last-resort kill: fires in edge cases where process.exit() is called without going
    // through shutdownEarlyBrowser() (e.g. buildFSTree ENOENT, signal kills). The normal
    // path calls shutdownEarlyBrowser() first, so Chrome is already dead here and this is
    // a no-op. SIGKILL is used so Chrome cannot stall the exit.
    try {
      earlyChrome.proc.kill('SIGKILL');
    } catch {
      // Already dead — ignore.
    }
  });
}

perfLog('early-chrome.js: module evaluated');

/**
 * Kills the pre-launched Chrome process and awaits its async temp-dir cleanup.
 * Must be called before process.exit() so the event loop is still alive and the
 * async rm() inside preLaunchChrome's close handler can run to completion.
 * Safe to call multiple times or when Chrome was never pre-launched (no-op).
 */
export async function shutdownEarlyBrowser(): Promise<void> {
  if (!earlyChrome) return;
  const { shutdown } = earlyChrome;
  earlyChrome = null; // prevent double-shutdown
  await shutdown();
}

/**
 * Resolves to `{ proc, cdpEndpoint, shutdown }` when Chrome is pre-launched and ready,
 * or `null` if pre-launch was skipped (non-run command or non-chromium browser).
 */
export const earlyBrowserPromise =
  isRunCommand && browserFromArgv === 'chromium'
    ? findChrome()
        .then((chromePath) => {
          perfLog('early-chrome.js: findChrome resolved', chromePath);
          return preLaunchChrome(chromePath, CHROMIUM_ARGS, !openWatchMode);
        })
        .then((info) => {
          perfLog('early-chrome.js: Chrome CDP ready', info?.cdpEndpoint ?? null);
          if (info) earlyChrome = info;
          return info;
        })
    : Promise.resolve(null);
