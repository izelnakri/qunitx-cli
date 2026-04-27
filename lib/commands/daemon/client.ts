import net from 'node:net';
import { existsSync } from 'node:fs';
import { daemonSocketPath } from '../../utils/daemon-socket-path.ts';
import { attachLineParser, probeSocket } from './socket-utils.ts';
import type { Request, ResponseChunk } from './protocol.ts';

const CONNECT_TIMEOUT_MS = 1_000;
const SIGINT_EXIT_CODE = 130;

/** True if the daemon socket file exists on disk for the given cwd (cheap presence check). */
export function daemonSocketExists(cwd: string = process.cwd()): boolean {
  return existsSync(daemonSocketPath(cwd));
}

/**
 * Decides whether the current invocation is a candidate for daemon dispatch.
 * Daemon is opt-in: only used when a live socket exists AND the run does not
 * require local browser/server lifecycle (watch / open / CI).
 */
export function shouldUseDaemon(): boolean {
  if (process.env.CI || process.env.QUNITX_NO_DAEMON) return false;
  const argv = process.argv;
  for (const arg of argv) {
    if (arg === '--no-daemon') return false;
    if (arg === '--watch' || arg === '-w') return false;
    if (arg === '--open' || arg === '-o' || arg.startsWith('--open=')) return false;
  }
  return daemonSocketExists();
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
