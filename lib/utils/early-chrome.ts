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
const browserFromArgv =
  process.argv.find((arg) => arg.startsWith('--browser='))?.split('=')[1] || 'chromium';

let earlyChromeProcRef = null;
process.on('exit', () => earlyChromeProcRef?.kill());

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
          return preLaunchChrome(chromePath, CHROMIUM_ARGS);
        })
        .then((info) => {
          perfLog('early-chrome.js: Chrome CDP ready', info?.cdpEndpoint ?? null);
          if (info) earlyChromeProcRef = info.proc;
          return info;
        })
    : Promise.resolve(null);
