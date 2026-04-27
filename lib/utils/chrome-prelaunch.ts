import { existsSync } from 'node:fs';
import { findChrome } from './find-chrome.ts';
import { preLaunchChrome } from './pre-launch-chrome.ts';
import { killProcessGroup } from './kill-process-group.ts';
import { CHROMIUM_ARGS } from './chromium-args.ts';
import { perfLog } from './perf-logger.ts';
import { daemonSocketPath } from './daemon-socket-path.ts';

// This module is statically imported by cli.ts so its module-level code runs
// at the very start of the process — before the IIFE, before playwright-core loads.
// For run commands only, Chrome is spawned immediately via CDP so it is ready
// (or nearly ready) by the time playwright-core finishes loading (~500ms later).
// For help/init/generate, nothing is spawned and this module costs ~0ms.

const NON_RUN_COMMANDS = new Set(['help', 'h', 'p', 'print', 'new', 'n', 'g', 'generate', 'init']);
const cmd = process.argv[2];
// `daemon _serve` is the daemon's own process — it DOES need Chrome. Other daemon
// subcommands (start/stop/status) are pure client ops and never need Chrome.
const isDaemonControlCmd = cmd === 'daemon' && process.argv[3] !== '_serve';
const isRunCommand = Boolean(cmd) && !NON_RUN_COMMANDS.has(cmd) && !isDaemonControlCmd;
const { browserFromArgv, openFromArgv, watchFromArgv } = process.argv.reduce(
  (flags, arg) => {
    if (arg.startsWith('--browser=')) flags.browserFromArgv = arg.slice(10);
    else if (arg === '--open' || arg === '-o') flags.openFromArgv = true;
    else if (arg === '--watch' || arg === '-w') flags.watchFromArgv = true;
    return flags;
  },
  // QUNITX_BROWSER env var seeds the default so prelaunch is skipped for firefox/webkit
  // even when --browser is not passed on the command line (e.g. browser-compat CI).
  {
    browserFromArgv: process.env.QUNITX_BROWSER || 'chromium',
    openFromArgv: false,
    watchFromArgv: false,
  },
);
// If the run will go through the daemon (existing socket OR QUNITX_DAEMON=1
// auto-spawn) and the invocation is daemon-eligible, no local Chrome is needed —
// skipping the prelaunch saves the ~150ms spawn cost.
const isDaemonClientRun =
  isRunCommand &&
  cmd !== 'daemon' &&
  !watchFromArgv &&
  !openFromArgv &&
  !process.env.CI &&
  !process.env.QUNITX_NO_DAEMON &&
  !process.argv.includes('--no-daemon') &&
  (Boolean(process.env.QUNITX_DAEMON) || existsSync(daemonSocketPath()));
// With --open --watch, Chrome is left alive after qunitx exits so the visible browser window persists.
// With --open alone, qunitx exits after tests complete; the detached browser is opened separately.
const openWatchMode = openFromArgv && watchFromArgv;

// Stored so the process.on('exit') safety net and shutdownPrelaunch() can reach Chrome.
let earlyChrome: import('../types.ts').EarlyChrome | null = null;

if (!openWatchMode) {
  process.on('exit', () => {
    if (!earlyChrome) return;
    // Last-resort kill: fires in edge cases where process.exit() is called without going
    // through shutdownPrelaunch() (e.g. buildFSTree ENOENT, signal kills). The normal
    // path calls shutdownPrelaunch() first, so Chrome is already dead here and this is
    // a no-op. SIGKILL is used so Chrome cannot stall the exit.
    killProcessGroup(earlyChrome.proc.pid!);
  });
}

perfLog('chrome-prelaunch.ts: module evaluated');

/**
 * Kills the pre-launched Chrome process and awaits its async temp-dir cleanup.
 * Must be called before process.exit() so the event loop is still alive and the
 * async rm() inside preLaunchChrome's close handler can run to completion.
 * Safe to call multiple times or when Chrome was never pre-launched (no-op).
 */
export async function shutdownPrelaunch(): Promise<void> {
  if (!earlyChrome) return;
  const { shutdown } = earlyChrome;
  earlyChrome = null; // prevent double-shutdown
  await shutdown();
}

/**
 * Resolves to `{ proc, cdpEndpoint, shutdown }` when Chrome is pre-launched and ready,
 * or `null` if pre-launch was skipped (non-run command, non-chromium browser, or macOS).
 *
 * macOS: pre-launch is skipped because the CI runner installs playwright-core's
 * chromium-headless-shell (not Google Chrome for Testing) and its path is not
 * known at module-evaluation time. playwright-core's chromium.launch() resolves
 * the binary correctly and is used directly in browser.ts.
 */
export const prelaunchPromise =
  isRunCommand &&
  !isDaemonClientRun &&
  browserFromArgv === 'chromium' &&
  process.platform !== 'darwin'
    ? findChrome()
        .then((chromePath) => {
          perfLog('chrome-prelaunch.ts: findChrome resolved', chromePath);
          return preLaunchChrome(chromePath, CHROMIUM_ARGS, !openWatchMode);
        })
        .then((info) => {
          perfLog('chrome-prelaunch.ts: Chrome CDP ready', info?.cdpEndpoint ?? null);
          if (info) earlyChrome = info;
          return info;
        })
    : Promise.resolve(null);
