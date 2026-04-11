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

let earlyChromeProcRef = null;
if (!openWatchMode) {
  process.on('exit', () => {
    if (!earlyChromeProcRef) return;
    // SIGKILL ensures Chrome terminates immediately on exit, preventing zombie Chrome
    // processes from consuming CPU on CI during subsequent test runs. SIGTERM can take
    // 1-3s for Chrome to process; SIGKILL is instantaneous. Chrome's child processes
    // (renderer, GPU) are supervised by Chrome and die when the browser process dies.
    try {
      earlyChromeProcRef.kill('SIGKILL');
    } catch {
      // Already dead — ignore.
    }
  });
}

perfLog('early-chrome.js: module evaluated');

/**
 * Resolves to `{ proc, cdpEndpoint }` when Chrome is pre-launched and ready,
 * or `null` if pre-launch was skipped (non-run command or non-chromium browser).
 * @type {Promise<{proc: import('node:child_process').ChildProcess, cdpEndpoint: string} | null>}
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
          if (info) earlyChromeProcRef = info.proc;
          return info;
        })
    : Promise.resolve(null);
