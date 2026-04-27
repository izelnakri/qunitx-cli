import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonSocketPath } from '../../utils/daemon-socket-path.ts';
import { pingDaemon, shutdownDaemon, tryConnect } from './client.ts';

const SPAWN_POLL_INTERVAL_MS = 100;
const SPAWN_TIMEOUT_MS = 10_000;

const __filename = fileURLToPath(import.meta.url);
// daemon/index.ts → ../../../cli.ts
const CLI_ENTRY = path.resolve(path.dirname(__filename), '..', '..', '..', 'cli.ts');

/**
 * Dispatches `qunitx daemon <subcommand>`. `_serve` runs the in-process daemon loop
 * (spawned by `start`); all other subcommands are client operations.
 */
export function runDaemonCommand(): Promise<number> {
  const sub = process.argv[3];
  if (sub === '_serve') return runServeMode();
  if (sub === 'start') return startDaemon();
  if (sub === 'stop') return stopDaemon();
  if (sub === 'status') return statusDaemon();
  process.stderr.write(
    'Usage: qunitx daemon <start|stop|status>\n' +
      '  start   Spawn a persistent daemon for this project\n' +
      '  stop    Stop the running daemon\n' +
      '  status  Print whether a daemon is running\n',
  );
  return Promise.resolve(sub ? 1 : 0);
}

async function runServeMode(): Promise<number> {
  const { runDaemonServer } = await import('./server.ts');
  await runDaemonServer();
  // Unreachable: runDaemonServer enters an event loop that exits via shutdownDaemon.
  return 0;
}

/**
 * Spawns a detached daemon process and polls until it answers a ping.
 * Returns the running daemon's pid on success, `null` on timeout. Used by both
 * the explicit `daemon start` and the auto-spawn path from cli.ts.
 */
async function spawnAndWaitForDaemon(): Promise<{ pid: number } | null> {
  // Detached so the daemon outlives the current shell. stdio: 'ignore' detaches all
  // pipes; daemon writes its own startup line to its stderr (now /dev/null analogue).
  spawn(process.execPath, [CLI_ENTRY, 'daemon', '_serve'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, QUNITX_DAEMON_CWD: process.cwd() },
  }).unref();

  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, SPAWN_POLL_INTERVAL_MS));
    const sock = await tryConnect();
    if (!sock) continue;
    sock.destroy();
    const pong = await pingDaemon();
    if (pong && pong.type === 'pong') return { pid: pong.pid };
  }
  return null;
}

/**
 * Ensures a daemon is reachable for the current cwd. Returns true if one was
 * already running or was successfully spawned; false on spawn timeout. Silent —
 * intended for the cli.ts auto-spawn path where the spawn is incidental to the run.
 */
export async function ensureDaemonRunning(): Promise<boolean> {
  const existing = await pingDaemon();
  if (existing && existing.type === 'pong') return true;
  return Boolean(await spawnAndWaitForDaemon());
}

async function startDaemon(): Promise<number> {
  const existing = await pingDaemon();
  if (existing && existing.type === 'pong') {
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
  if (!pong || pong.type !== 'pong') {
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
