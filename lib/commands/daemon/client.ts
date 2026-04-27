import net from 'node:net';
import { existsSync } from 'node:fs';
import { daemonSocketPath, daemonInfoPath } from '../../utils/daemon-socket-path.ts';
import { attachLineParser, probeSocket } from './socket-utils.ts';
import type { Request, ResponseChunk } from './protocol.ts';

const CONNECT_TIMEOUT_MS = 1_000;
const SIGINT_EXIT_CODE = 130;

/**
 * True if a daemon appears to be present for the given cwd. Checks the sidecar JSON
 * file rather than the socket path because Windows named pipes are not visible on the
 * regular filesystem (existsSync on `\\.\pipe\...` always returns false). The info
 * file is created at startup and unlinked at shutdown — a reliable cross-platform
 * sentinel. Stale info files are caught downstream by tryConnect failing fast.
 */
export function daemonSocketExists(cwd: string = process.cwd()): boolean {
  return existsSync(daemonInfoPath(cwd));
}

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

/**
 * True iff a live daemon socket exists and the invocation can use it. The cli's
 * primary dispatch check.
 */
export function shouldUseDaemon(): boolean {
  return isDaemonEligible() && daemonSocketExists();
}

/**
 * True iff the user opted in to auto-spawn (`QUNITX_DAEMON=1`), the invocation
 * is daemon-eligible, and no daemon is running yet — meaning cli should spawn
 * one before dispatching the run.
 */
export function shouldAutoSpawnDaemon(): boolean {
  return Boolean(process.env.QUNITX_DAEMON) && isDaemonEligible() && !daemonSocketExists();
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
  let result: ResponseChunk | null = null;
  attachLineParser<ResponseChunk>(socket, (chunk) => {
    if (chunk.type === 'pong') {
      result = chunk;
      socket.end();
    }
  });
  send(socket, { type: 'ping' });
  await awaitClose(socket);
  return result;
}

/** Sends `shutdown`. Returns `true` if a daemon was reached and asked to stop, `false` otherwise. */
export async function shutdownDaemon(): Promise<boolean> {
  const socket = await tryConnect();
  if (!socket) return false;
  attachLineParser<ResponseChunk>(socket, () => {});
  send(socket, { type: 'shutdown' });
  await awaitClose(socket);
  return true;
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

  let exitCode: number | null = null;
  attachLineParser<ResponseChunk>(socket, (chunk) => {
    if (chunk.type === 'stdout') process.stdout.write(chunk.data);
    else if (chunk.type === 'stderr') process.stderr.write(chunk.data);
    else if (chunk.type === 'done') exitCode = chunk.exitCode;
    else if (chunk.type === 'fatal') {
      process.stderr.write(`# [qunitx daemon] ${chunk.message}\n`);
      exitCode = exitCode ?? 1;
    }
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
    await awaitClose(socket);
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  return exitCode ?? 1;
}
