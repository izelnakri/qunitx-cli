import { existsSync } from 'node:fs';
import { find } from './find.ts';
import { spawn } from './spawn.ts';
import { killProcessGroup } from '../utils/kill-process-group.ts';
import { CHROMIUM_ARGS } from './chromium-args.ts';
import { perfLog } from '../utils/perf-log.ts';
import * as Paths from '../commands/daemon/paths.ts';
import type { ChromeHandle, EarlyChrome } from '../types.ts';

// Chrome pre-launch: spawn the browser via CDP before playwright-core has even finished
// loading, so its ~150ms start-up hides behind module evaluation instead of following it.
//
// Opt-in, via `startPrelaunch()`. It used to run on module evaluation, which was right for the
// one process that has a qunitx argv and wrong for every other: importing the JS API would
// sniff the *host's* argv, decide it looked like a run, and spawn a Chrome nobody asked for.
// `cli.ts` calls this as its first statement, which is the same point in time — everything
// between is its own static import graph, and playwright-core is not in it.

// The pre-launched Chrome's handle, reachable by the process.on('exit') safety net and
// shutdownPrelaunch(). Set synchronously the instant Chrome is spawned (via onSpawn below), so it
// is never partial: null before spawn, or a complete handle with a callable shutdown. That
// invariant is load-bearing — shutdownPrelaunch()'s guard depends on it — and it closes the leak
// window where a parent process.exit() between spawn and CDP-ready would orphan Chrome (the
// detached process group outlives the parent).
let earlyChrome: ChromeHandle | null = null;

/**
 * Kills the pre-launched Chrome process and awaits its async temp-dir cleanup.
 * Must be called before process.exit() so the event loop is still alive and the
 * async rm() inside spawn's close handler can run to completion.
 * Safe to call multiple times or when Chrome was never pre-launched (no-op).
 *
 * ```ts
 * await shutdownPrelaunch(); // no-op when nothing was pre-launched; idempotent otherwise
 * ```
 */
export async function shutdownPrelaunch(): Promise<void> {
  if (!earlyChrome) return;
  const { shutdown } = earlyChrome;
  earlyChrome = null; // prevent double-shutdown
  await shutdown();
}

/**
 * The in-flight pre-launch, or a resolved `null` when {@link startPrelaunch} was never called
 * or decided not to spawn (non-run command, `--search`, a daemon-routed run, non-chromium, or
 * macOS — where the CI runner installs playwright's own headless shell and its path is not
 * known this early).
 *
 * ```ts
 * import { prelaunchPromise } from './prelaunch.ts';
 *
 * await prelaunchPromise(); // null — nothing was pre-launched in this process
 * ```
 */
export function prelaunchPromise(): Promise<EarlyChrome | null> {
  return inFlight;
}

let inFlight: Promise<EarlyChrome | null> = Promise.resolve(null);

/**
 * Starts Chrome now, if this invocation is one that will need it.
 *
 * Call it as early as possible and exactly once: the whole benefit is the overlap with the
 * module loading that follows, and a second call is a no-op rather than a second browser.
 * The decision reads `process.argv` directly rather than going through the shared tokenizer —
 * this runs at ~t=5ms and stays free of avoidable imports.
 *
 * ```ts
 * import { startPrelaunch } from './prelaunch.ts';
 *
 * // Defined, not invoked: spawns a real Chrome process.
 * function begin() {
 *   startPrelaunch(); // resolves through prelaunchPromise() once CDP is ready
 * }
 * ```
 */
export function startPrelaunch(): void {
  if (started) return;
  started = true;

  const NON_RUN_COMMANDS = new Set([
    'help',
    'h',
    'p',
    'print',
    'new',
    'n',
    'g',
    'generate',
    'init',
    'upgrade',
  ]);
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
    // `repl` opens a page of its own and keeps it: it never routes to the daemon, so it wants
    // the pre-launched Chrome even when a daemon is up.
    cmd !== 'repl' &&
    !watchFromArgv &&
    !openFromArgv &&
    !process.env.QUNITX_NO_DAEMON &&
    !process.argv.includes('--no-daemon') &&
    (!process.env.CI || Boolean(process.env.QUNITX_DAEMON)) &&
    // Check the info file rather than the socket path: on Windows the socket is a named
    // pipe (\\.\pipe\...), which existsSync cannot see. The info file is always a regular
    // file in os.tmpdir() and is created/removed in lockstep with the daemon's lifetime.
    (Boolean(process.env.QUNITX_DAEMON) || existsSync(Paths.info()));
  // With --open --watch, Chrome is left alive after qunitx exits so the visible browser window persists.
  // With --open alone, qunitx exits after tests complete; the detached browser is opened separately.
  const openWatchMode = openFromArgv && watchFromArgv;

  if (!openWatchMode) {
    process.on('exit', () => {
      const proc = earlyChrome?.proc;
      if (proc?.pid == null) return;
      // Last-resort kill: fires in edge cases where process.exit() is called without going
      // through shutdownPrelaunch() (e.g. FSTree.build ENOENT, signal kills, daemon
      // shutdown mid-launch). The normal path calls shutdownPrelaunch() first, so Chrome
      // is already dead here and this is a no-op. SIGKILL so Chrome cannot stall exit.
      killProcessGroup(proc.pid);
    });
  }

  const shouldSpawn =
    isRunCommand &&
    !isDaemonClientRun &&
    !searchFromArgv &&
    browserFromArgv === 'chromium' &&
    process.platform !== 'darwin';
  if (!shouldSpawn) return;

  inFlight = find()
    .then((chromePath) => {
      perfLog('chrome-prelaunch.ts: Chrome.find resolved', chromePath);
      // onSpawn fires synchronously inside spawn the instant Chrome is spawned, before the
      // CDP-ready stderr match — so earlyChrome holds a fully-callable handle for the entire
      // process lifetime, including the spawn→CDP-ready gap.
      return spawn(chromePath, CHROMIUM_ARGS, !openWatchMode, (handle) => {
        earlyChrome = handle;
      });
    })
    .then((info) => {
      perfLog('chrome-prelaunch.ts: Chrome CDP ready', info?.cdpEndpoint ?? null);
      return info;
    });
}

let started = false;
