import { spawn } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import path from 'node:path';
import { blue, magenta } from '../../utils/color.ts';
import { daemonInfoPath, daemonSocketPath } from '../../utils/daemon-socket-path.ts';
import { parseDaemonIdleTimeout } from '../../utils/parse-daemon-idle-timeout.ts';
import { pingDaemon, shutdownDaemon } from './client.ts';
import pkg from '../../../package.json' with { type: 'json' };

// Daemon startup chains: cli.ts import → setupConfig → launchBrowser (chromium
// connect) → listen() → writeFile(info). Observed timings:
//   Linux/macOS: typical 0.8–2 s, worst observed ~5 s.
//   Windows under heavy CI load: typical 4–8 s, worst observed ~12 s
//     (run 25088766035 timed out at the previous 10 s budget).
// 30 s is biased hard toward flake-prevention: a false timeout (legit-slow startup
// hits the deadline) costs a red CI run and a re-run, while a true timeout (daemon
// genuinely won't start) just adds ~20 s before the user gets an error — rare and
// tolerable. Stays under DEFAULT_EXEC_TIMEOUT_MS (60 s) so test runs that wrap
// `daemon start` keep envelope headroom.
const SPAWN_TIMEOUT_MS = 30_000;

const highlight = (text: string): string => magenta().bold(text);
const color = (text: string): string => blue(text);

const USAGE = `${highlight(`[qunitx v${pkg.version}] Usage:`)} qunitx ${color('daemon <subcommand>')}

${highlight('Subcommands:')}
${color('$ qunitx daemon start')}    # Spawn a persistent daemon for this project (~2× faster repeated runs)
${color('$ qunitx daemon stop')}     # Stop the running daemon
${color('$ qunitx daemon status')}   # Print pid, socket, and uptime

${highlight('Environment:')}
${color('QUNITX_DAEMON=1')}              : auto-spawn the daemon on the first qunitx run; reuse it on every run after (overrides the CI=1 bypass)
${color('QUNITX_NO_DAEMON=1')}           : never use the daemon for this run
${color('QUNITX_DAEMON_IDLE_TIMEOUT')}   : idle window before self-shutdown (default 30m). Bare number = minutes; ${color('ms')} / ${color('s')} / ${color('m')} / ${color('h')} suffixes accepted (${color('1h')}, ${color('45s')}, ${color('500ms')}). Set to ${color('false')} to disable auto-shutdown. Read at daemon spawn; invalid values warn and fall back to the default.
${color('QUNITX_DAEMON_LOG=<path>')}     : redirect the daemon's stdout + stderr to a file (otherwise lost to the detached spawn)

${highlight('Tip:')} set ${color('QUNITX_DAEMON=1')} to auto-spawn the daemon on the first qunitx run; ${color('$ qunitx --help')} for top-level options.
`;

/**
 * Resolves how to respawn this CLI as the detached daemon child.
 *
 * - SEA: `process.execPath` IS the qunitx binary; reinvoke with `daemon _serve`.
 *   `import.meta.url` is undefined in the CJS SEA bundle, so any path-based
 *   resolution at module scope crashes the entire `daemon` subcommand.
 * - Source / dist bundle (ESM): respawn `node ${process.argv[1]} daemon _serve`
 *   so the child enters via the same entrypoint the parent did (cli.ts in
 *   source, bin/qunitx.js when installed via npm). The previous
 *   `fileURLToPath(import.meta.url)` + `'..','..','..','cli.ts'` resolution
 *   was wrong for the ESM bundle too — three levels up from `dist/cli.js`
 *   pointed outside the package.
 */
async function buildDaemonSpawn(): Promise<{ bin: string; args: string[] }> {
  const sea = await import('node:sea').catch(() => null);
  if (sea?.isSea()) return { bin: process.execPath, args: ['daemon', '_serve'] };
  return { bin: process.execPath, args: [process.argv[1], 'daemon', '_serve'] };
}

/**
 * Dispatches `qunitx daemon <subcommand>`. `_serve` runs the in-process daemon loop
 * (spawned by `start`); all other subcommands are client operations. No subcommand
 * (or `--help` / `-h` / `help`) prints usage and exits 0; an unknown subcommand
 * prints usage to stderr and exits 1.
 */
export function runDaemonCommand(): Promise<number> {
  const sub = process.argv[3];
  if (sub === '_serve') return runServeMode();
  if (sub === 'start') return startDaemon();
  if (sub === 'stop') return stopDaemon();
  if (sub === 'status') return statusDaemon();
  const helpRequested = !sub || sub === '--help' || sub === '-h' || sub === 'help';
  const out = helpRequested ? process.stdout : process.stderr;
  out.write(USAGE);
  return Promise.resolve(helpRequested ? 0 : 1);
}

async function runServeMode(): Promise<number> {
  const { runDaemonServer } = await import('./server.ts');
  await runDaemonServer();
  // Unreachable: runDaemonServer enters an event loop that exits via shutdownDaemon.
  return 0;
}

/**
 * Event-driven wait for `filePath` to appear, bounded by `timeoutMs`. Subscribes via
 * `fs.watch` on the parent directory — kernel notifications (inotify / FSEvents /
 * ReadDirectoryChangesW) deliver events sub-ms after file creation, so detection
 * latency is OS-bound, not poll-interval-bound, and zero CPU is burned between events.
 *
 * Two `existsSync` calls bracket the watcher attachment to close the TOCTOU gap:
 * the file may appear between the entry-point check and `fs.watch` actually being
 * subscribed in the kernel. Multiple `settle` calls are harmless: `resolve`,
 * `clearTimeout`, and `fsWatcher.close` are all idempotent.
 */
function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  if (existsSync(filePath)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const dir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const settle = (ok: boolean) => {
      clearTimeout(timer);
      watcher.close();
      resolve(ok);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    const watcher = fs.watch(dir, (_event, name) => {
      // Reconfirm with existsSync — fs.watch fires for both create and unlink.
      if (name === fileName && existsSync(filePath)) settle(true);
    });
    watcher.on('error', () => settle(false));
    // Re-check now that the kernel watch is live (TOCTOU close).
    if (existsSync(filePath)) settle(true);
  });
}

/**
 * Spawns a detached daemon process and waits for it to be *fully* ready.
 *
 * Two signals must both be true before we return success:
 *
 * 1. The info file exists at `daemonInfoPath()`. The daemon writes this *after*
 *    `listen()` resolves, so its presence is the first observable signal that
 *    startup is complete. We wait for it via `fs.watch` — event-driven, no polling.
 * 2. `pingDaemon()` returns a `pong`. Confirms the daemon is actually accepting
 *    connections (rules out a stale info file from a crashed previous daemon).
 *
 * Either signal alone is insufficient: pong-only races the post-listen writeFile
 * (sub-ms on Linux, tens of ms on Windows NTFS); file-only would falsely accept
 * stale presence sentinels. Both must hold.
 */
async function spawnAndWaitForDaemon(): Promise<{ pid: number } | null> {
  // Validate QUNITX_DAEMON_IDLE_TIMEOUT here — the daemon detaches with stdio:'ignore'
  // so a warning printed from inside it is invisible. Doing it on the CLI side puts
  // the message on the user's terminal at the moment the env value first becomes
  // load-bearing (i.e. a fresh spawn).
  const parsed = parseDaemonIdleTimeout(process.env.QUNITX_DAEMON_IDLE_TIMEOUT);
  if (parsed.warning) process.stderr.write(parsed.warning + '\n');

  // Detached so the daemon outlives the current shell. stdio: 'ignore' detaches all
  // pipes; daemon writes its own startup line to its stderr (now /dev/null analogue).
  const { bin, args } = await buildDaemonSpawn();
  spawn(bin, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, QUNITX_DAEMON_CWD: process.cwd() },
  }).unref();

  if (!(await waitForFile(daemonInfoPath(), SPAWN_TIMEOUT_MS))) return null;
  const pong = await pingDaemon();
  return pong?.type === 'pong' ? { pid: pong.pid } : null;
}

/**
 * Ensures a daemon is reachable for the current cwd. Returns true if one was
 * already running or was successfully spawned; false on spawn timeout. Silent —
 * intended for the cli.ts auto-spawn path where the spawn is incidental to the run.
 */
export async function ensureDaemonRunning(): Promise<boolean> {
  if ((await pingDaemon())?.type === 'pong') return true;
  return Boolean(await spawnAndWaitForDaemon());
}

async function startDaemon(): Promise<number> {
  const existing = await pingDaemon();
  if (existing?.type === 'pong') {
    process.stdout.write(`Daemon already running (pid ${existing.pid})\n`);
    return 0;
  }
  const result = await spawnAndWaitForDaemon();
  if (result) {
    process.stdout.write(`Daemon started (pid ${result.pid})\n`);
    return 0;
  }
  process.stderr.write(`Daemon did not start within ${SPAWN_TIMEOUT_MS / 1000}s\n`);
  return 1;
}

async function stopDaemon(): Promise<number> {
  const stopped = await shutdownDaemon();
  process.stdout.write(stopped ? 'Daemon stopped\n' : 'No daemon was running\n');
  return 0;
}

async function statusDaemon(): Promise<number> {
  const pong = await pingDaemon();
  if (pong?.type !== 'pong') {
    process.stdout.write('No daemon running for this project\n');
    return 1;
  }
  const ageMin = Math.round((Date.now() - pong.startedAt) / 60_000);
  process.stdout.write(
    `Daemon running\n` +
      `  pid:     ${pong.pid}\n` +
      `  cwd:     ${pong.cwd}\n` +
      `  node:    ${pong.nodeVersion}\n` +
      `  uptime:  ${ageMin} min\n` +
      `  socket:  ${daemonSocketPath(pong.cwd)}\n`,
  );
  return 0;
}
