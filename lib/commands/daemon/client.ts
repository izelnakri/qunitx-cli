import net from 'node:net';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { daemonSocketPath, daemonInfoPath } from '../../utils/daemon-socket-path.ts';
import { CLEANUP_GRACE_MS } from '../../utils/close-with-grace.ts';
import { attachLineParser, probeSocket } from './socket-utils.ts';
import type { Request, ResponseChunk } from './protocol.ts';

const CONNECT_TIMEOUT_MS = 1_000;
const SIGINT_EXIT_CODE = 130;
// Maximum time to wait for the daemon process to fully exit after `daemon stop`
// returns 'done'. Two reasons we cap this rather than poll forever:
//   1. PID reuse — once the daemon's pid is freed, the OS can recycle it for an
//      unrelated process within seconds; without a deadline `process.kill(pid, 0)`
//      would succeed forever against the recycled pid and block stop indefinitely.
//   2. CLI / scripting UX — a daemon stuck in cleanup (browser.close deadlock on
//      Firefox+Windows, server.close hanging) shouldn't freeze the cli.
// Same bound as CLEANUP_GRACE_MS — single source of truth for "worst tolerated
// cleanup time" across the codebase. Generous enough for a loaded CI runner where
// browser.close + esbuild dispose can take several seconds under contention.
const SHUTDOWN_PID_WAIT_MS = CLEANUP_GRACE_MS;
// Poll interval while waiting for the daemon's pid to disappear. 50ms keeps the
// follow-up `daemon start` snappy without burning CPU.
const SHUTDOWN_PID_POLL_MS = 50;

/**
 * True if the run could meaningfully use a daemon: not opted out, not a watch/open
 * mode (those need their own browser lifecycle locally). CI is bypassed by default
 * (single-invocation CI jobs lose to daemon's spawn cost) but `QUNITX_DAEMON=1`
 * overrides — multi-invocation CI flows (monorepos running qunitx per package) can
 * opt in. Explicit user intent always beats environment-driven default.
 */
function isDaemonEligible(): boolean {
  if (process.env.QUNITX_NO_DAEMON) return false;
  if (process.env.CI && !process.env.QUNITX_DAEMON) return false;
  for (const arg of process.argv) {
    if (arg === '--no-daemon') return false;
    if (arg === '--watch' || arg === '-w') return false;
    if (arg === '--open' || arg === '-o' || arg.startsWith('--open=')) return false;
  }
  return true;
}

// daemonInfoPath() is the cross-platform "is a daemon present?" sentinel — checked
// rather than the socket itself because on Windows named pipes (\\.\pipe\...) are
// not visible to existsSync. The info file is created at startup and unlinked at
// shutdown; stale files are caught downstream when tryConnect fails fast.

/**
 * True iff a live daemon socket exists and the invocation can use it. The cli's
 * primary dispatch check.
 */
export function shouldUseDaemon(): boolean {
  return isDaemonEligible() && existsSync(daemonInfoPath());
}

/**
 * True iff the user opted in to auto-spawn (`QUNITX_DAEMON=1`), the invocation
 * is daemon-eligible, and no daemon is running yet — meaning cli should spawn
 * one before dispatching the run.
 */
export function shouldAutoSpawnDaemon(): boolean {
  return Boolean(process.env.QUNITX_DAEMON) && isDaemonEligible() && !existsSync(daemonInfoPath());
}

/**
 * Opens a connection to the daemon for the given cwd. Resolves the connected socket
 * on success; resolves `null` on any failure (no socket file, ECONNREFUSED, timeout).
 */
export function tryConnect(cwd: string = process.cwd()): Promise<net.Socket | null> {
  return probeSocket(daemonSocketPath(cwd), CONNECT_TIMEOUT_MS);
}

function send(socket: net.Socket, req: Request): void {
  socket.write(JSON.stringify(req) + '\n');
}

/** Awaits socket close (any path: end / close / error). */
function awaitClose(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    socket.once('end', () => resolve());
    socket.once('close', () => resolve());
    socket.once('error', () => resolve());
  });
}

/** Sends a `ping` and resolves the daemon's `pong` response (or `null` on failure). */
export async function pingDaemon(): Promise<ResponseChunk | null> {
  const socket = await tryConnect();
  if (!socket) return null;
  const result = new Promise<ResponseChunk | null>((resolve) => {
    attachLineParser<ResponseChunk>(socket, (chunk) => {
      if (chunk.type === 'pong') resolve(chunk);
    });
    socket.once('close', () => resolve(null));
    socket.once('error', () => resolve(null));
  });
  send(socket, { type: 'ping' });
  const pong = await result;
  socket.end();
  return pong;
}

/**
 * Sends `shutdown` and waits until the daemon has actually fully exited — not just
 * until the socket closes. The daemon's dispatch handler acks 'done' before its
 * async cleanup (server.close / browser.close / process.exit) runs, so a naive
 * "stop returned" signal leaves the daemon's socket / named-pipe handle still
 * held. A fast follow-up `daemon start` would then race the dying daemon and hit
 * EADDRINUSE — observed reliably on Windows where named-pipe handle release lags
 * process exit by tens of milliseconds.
 *
 * Reads the pid upfront (before sending shutdown — the daemon sync-unlinks the
 * info file in its dispatch handler, so we can't read it after) and polls
 * `process.kill(pid, 0)` until ESRCH. Bounded by `SHUTDOWN_PID_WAIT_MS`.
 *
 * Returns `true` if a daemon was reached and asked to stop, `false` if no daemon
 * was running.
 */
export async function shutdownDaemon(): Promise<boolean> {
  const pid = await readDaemonPid();

  const socket = await tryConnect();
  if (!socket) return false;
  attachLineParser<ResponseChunk>(socket, () => {});
  send(socket, { type: 'shutdown' });
  await awaitClose(socket);

  if (pid !== null) await waitForPidExit(pid, SHUTDOWN_PID_WAIT_MS);
  return true;
}

async function readDaemonPid(): Promise<number | null> {
  try {
    const info = JSON.parse(await fs.readFile(daemonInfoPath(), 'utf8')) as { pid?: unknown };
    return typeof info.pid === 'number' ? info.pid : null;
  } catch {
    return null;
  }
}

function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      if (!pidIsAlive(pid) || Date.now() >= deadline) return resolve();
      setTimeout(poll, SHUTDOWN_PID_POLL_MS);
    };
    poll();
  });
}

function pidIsAlive(pid: number): boolean {
  // process.kill(pid, 0) is the portable "does this pid exist?" check. Throws
  // ESRCH when gone, EPERM when alive but not signalable. Daemon is our own
  // child so EPERM is unexpected — treat as alive defensively.
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Sends `argv` to the daemon and streams its TAP output back to local stdout/stderr.
 * Returns the exit code reported by the daemon. Throws if the connection fails.
 * Forwards the user's Ctrl+C: client exits with 130; daemon abandons the run cleanly
 * when it sees the socket close (clientAlive=false stops further writes).
 */
export async function runViaDaemon(argv: string[]): Promise<number> {
  const socket = await tryConnect();
  if (!socket) throw new Error('daemon connect failed');

  // Per protocol.ts: exactly one terminal message ('done' or 'fatal') ends the
  // stream. close/error here are last-resort fallbacks for a daemon that drops
  // the connection without sending one.
  const exitCode = new Promise<number>((resolve) => {
    attachLineParser<ResponseChunk>(socket, (chunk) => {
      if (chunk.type === 'stdout') process.stdout.write(chunk.data);
      else if (chunk.type === 'stderr') process.stderr.write(chunk.data);
      else if (chunk.type === 'done') resolve(chunk.exitCode);
      else if (chunk.type === 'fatal') {
        process.stderr.write(`# [qunitx daemon] ${chunk.message}\n`);
        resolve(1);
      }
    });
    socket.once('close', () => resolve(1));
    socket.once('error', () => resolve(1));
  });

  const onSigint = () => {
    socket.end();
    process.exit(SIGINT_EXIT_CODE);
  };
  process.once('SIGINT', onSigint);

  send(socket, {
    type: 'run',
    argv,
    cwd: process.cwd(),
    env: { ...process.env },
    nodeVersion: process.version,
  });

  try {
    return await exitCode;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}
