import { existsSync } from 'node:fs';
import { findChrome } from './find.ts';
import { preLaunchChrome } from './spawn.ts';
import { killProcessGroup } from '../utils/kill-process-group.ts';
import { CHROMIUM_ARGS } from './args.ts';
import { perfLog } from '../utils/perf-logger.ts';
import { daemonInfoPath } from '../commands/daemon/socket-path.ts';

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
// --search/--print lists tests from a static scan and exits — it never opens a browser. It also
// finishes faster than Chrome's CDP becomes ready, so a prelaunch would not merely be wasted: the
// shutdown handle does not exist yet when the process exits, leaving an orphaned Chrome and its
// user-data-dir behind. Not spawning at all is both the fix and the fast path.
// A deliberately local argv scan rather than the shared tokenizer: this module is statically
// imported first so Chrome spawns at ~t=5ms, and it stays free of avoidable imports.
const SEARCH_FLAG = /^(-s|--search|--print|--preview)(=|$)/;
const { browserFromArgv, openFromArgv, watchFromArgv, searchFromArgv } = process.argv.reduce(
  (flags, arg) => {
    if (arg.startsWith('--browser=')) flags.browserFromArgv = arg.slice(10);
    else if (arg === '--open' || arg === '-o') flags.openFromArgv = true;
    else if (arg === '--watch' || arg === '-w') flags.watchFromArgv = true;
    else if (SEARCH_FLAG.test(arg)) flags.searchFromArgv = true;
    return flags;
  },
  // QUNITX_BROWSER env var seeds the default so prelaunch is skipped for firefox/webkit
  // even when --browser is not passed on the command line (e.g. browser-compat CI).
  {
    browserFromArgv: process.env.QUNITX_BROWSER || 'chromium',
    openFromArgv: false,
    watchFromArgv: false,
    searchFromArgv: false,
  },
);
// If the run will go through the daemon (existing socket OR QUNITX_DAEMON=1
// auto-spawn) and the invocation is daemon-eligible, no local Chrome is needed —
// skipping the prelaunch saves the ~150ms spawn cost. CI is bypassed by default
// but QUNITX_DAEMON=1 overrides (mirrors the precedence in client.ts).
const isDaemonClientRun =
  isRunCommand &&
  cmd !== 'daemon' &&
  !watchFromArgv &&
  !openFromArgv &&
  !process.env.QUNITX_NO_DAEMON &&
  !process.argv.includes('--no-daemon') &&
  (!process.env.CI || Boolean(process.env.QUNITX_DAEMON)) &&
  // Check the info file rather than the socket path: on Windows the socket is a named
  // pipe (\\.\pipe\...), which existsSync cannot see. The info file is always a regular
  // file in os.tmpdir() and is created/removed in lockstep with the daemon's lifetime.
  (Boolean(process.env.QUNITX_DAEMON) || existsSync(daemonInfoPath()));
// With --open --watch, Chrome is left alive after qunitx exits so the visible browser window persists.
// With --open alone, qunitx exits after tests complete; the detached browser is opened separately.
const openWatchMode = openFromArgv && watchFromArgv;

// Stored so the process.on('exit') safety net and shutdownPrelaunch() can reach Chrome.
let earlyChrome: import('../types.ts').EarlyChrome | null = null;
// Tracked synchronously the moment Chrome is spawned (before CDP-ready) so the
// process.on('exit') fallback can SIGKILL the Chrome process even if the daemon
// exits mid-launch. Without this the decoupled-launch daemon path leaks Chrome
// when shutdown happens during the gap between spawn and CDP-ready, because
// `detached: true` keeps the Chrome process group alive after the parent dies.
let earlyChromeProc: import('node:child_process').ChildProcess | null = null;

if (!openWatchMode) {
  process.on('exit', () => {
    // Prefer the fully-realised earlyChrome (it points to the same proc); fall back
    // to the synchronously-tracked proc when CDP-ready hasn't fired yet.
    const proc = earlyChrome?.proc ?? earlyChromeProc;
    if (proc?.pid == null) return;
    // Last-resort kill: fires in edge cases where process.exit() is called without going
    // through shutdownPrelaunch() (e.g. FSTree.build ENOENT, signal kills, daemon
    // shutdown mid-launch). The normal path calls shutdownPrelaunch() first, so Chrome
    // is already dead here and this is a no-op. SIGKILL so Chrome cannot stall exit.
    killProcessGroup(proc.pid);
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
  !searchFromArgv &&
  browserFromArgv === 'chromium' &&
  process.platform !== 'darwin'
    ? findChrome()
        .then((chromePath) => {
          perfLog('chrome-prelaunch.ts: findChrome resolved', chromePath);
          // onSpawn fires synchronously inside preLaunchChrome the instant Chrome
          // is `spawn()`d, before the CDP-ready stderr match. Tracking the proc
          // here closes the leak window during which a parent process.exit()
          // would otherwise leave Chrome orphaned (the on('exit') hook above
          // only had access to `earlyChrome` post-CDP-ready before this change).
          return preLaunchChrome(chromePath, CHROMIUM_ARGS, !openWatchMode, (proc) => {
            earlyChromeProc = proc;
          });
        })
        .then((info) => {
          perfLog('chrome-prelaunch.ts: Chrome CDP ready', info?.cdpEndpoint ?? null);
          if (info) earlyChrome = info;
          return info;
        })
    : Promise.resolve(null);
