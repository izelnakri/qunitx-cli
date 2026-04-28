import { spawn } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonInfoPath, daemonSocketPath } from '../../utils/daemon-socket-path.ts';
import { pingDaemon, shutdownDaemon } from './client.ts';

const SPAWN_TIMEOUT_MS = 10_000;

const __filename = fileURLToPath(import.meta.url);
// daemon/index.ts → ../../../cli.ts
const CLI_ENTRY = path.resolve(path.dirname(__filename), '..', '..', '..', 'cli.ts');

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
  out.write(
    'Usage: qunitx daemon <start|stop|status>\n' +
      '  start   Spawn a persistent daemon for this project (~2× faster repeated runs)\n' +
      '  stop    Stop the running daemon\n' +
      '  status  Print whether a daemon is running\n' +
      '\n' +
      'Tip: set QUNITX_DAEMON=1 to auto-spawn the daemon on the first qunitx run.\n',
  );
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
 * subscribed in the kernel.
 */
function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  if (existsSync(filePath)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const dir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
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
  // Detached so the daemon outlives the current shell. stdio: 'ignore' detaches all
  // pipes; daemon writes its own startup line to its stderr (now /dev/null analogue).
  spawn(process.execPath, [CLI_ENTRY, 'daemon', '_serve'], {
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
  process.stderr.write('Daemon did not start within 10s\n');
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
