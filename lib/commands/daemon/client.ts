import net from 'node:net';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as Paths from './paths.ts';
import { CLEANUP_GRACE_MS } from '../../utils/close-with-grace.ts';
import * as Args from '../../args/index.ts';
import * as Socket from './socket.ts';
import { Failure } from '../../result/index.ts';
import { Task } from '../../task/index.ts';
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

// Paths.info() is the cross-platform "is a daemon present?" sentinel — checked
// rather than the socket itself because on Windows named pipes (\\.\pipe\...) are
// not visible to existsSync. The info file is created at startup and unlinked at
// shutdown; stale files are caught downstream when tryConnect fails fast.

/**
 * True iff a live daemon socket exists and the invocation can use it. The cli's
 * primary dispatch check.
 *
 * ```ts
 * import * as Client from './client.ts';
 *
 * // Defined, not invoked: checks env, argv and the on-disk sentinel for process.cwd().
 * function daemonAvailable() {
 *   return Client.shouldUse(); // true only when eligible and a daemon info file exists
 * }
 * ```
 */
export function shouldUse(): boolean {
  return isDaemonEligible() && existsSync(Paths.info());
}

/**
 * True iff the user opted in to auto-spawn (`QUNITX_DAEMON=1`), the invocation
 * is daemon-eligible, and no daemon is running yet — meaning cli should spawn
 * one before dispatching the run.
 *
 * ```ts
 * import * as Client from './client.ts';
 *
 * // Defined, not invoked: reads env + the on-disk sentinel for process.cwd().
 * function needsSpawn() {
 *   return Client.shouldAutoSpawn(); // true → cli spawns the daemon before dispatching
 * }
 * ```
 */
export function shouldAutoSpawn(): boolean {
  return Boolean(process.env.QUNITX_DAEMON) && isDaemonEligible() && !existsSync(Paths.info());
}

/**
 * Opens a connection to the daemon for the given cwd. Resolves the connected socket
 * on success; resolves `null` on any failure (no socket file, ECONNREFUSED, timeout).
 *
 * ```ts
 * import * as Client from './client.ts';
 *
 * // Defined, not invoked: dials the project's daemon socket.
 * async function probe() {
 *   return await Client.tryConnect('/proj'); // net.Socket, or null within 1s on any failure
 * }
 * ```
 */
export function tryConnect(cwd: string = process.cwd()): Promise<net.Socket | null> {
  return Socket.connect(Paths.socket(cwd), CONNECT_TIMEOUT_MS);
}

/**
 * Sends a `ping` and resolves the daemon's `pong` response (or `null` on failure).
 *
 * ```ts
 * import * as Client from './client.ts';
 *
 * // Defined, not invoked: one ping/pong round-trip over the daemon socket.
 * async function daemonIdentity() {
 *   return await Client.ping(); // { type: 'pong', pid, nodeVersion, cwd, startedAt } or null
 * }
 * ```
 */
export async function ping(): Promise<ResponseChunk | null> {
  const socket = await tryConnect();
  if (!socket) return null;
  const result = new Promise<ResponseChunk | null>((resolve) => {
    Socket.readMessages<ResponseChunk>(socket, (chunk) => {
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
 *
 * ```ts
 * import * as Client from './client.ts';
 *
 * // Defined, not invoked: `qunitx daemon stop` — IPC plus a bounded pid-exit poll.
 * async function stopDaemon() {
 *   return await Client.shutdown(); // true if a daemon was reached, false when none was running
 * }
 * ```
 */
export async function shutdown(cwd: string = process.cwd()): Promise<boolean> {
  const pid = await readDaemonPid(cwd);

  const socket = await tryConnect(cwd);
  if (!socket) return false;
  Socket.readMessages<ResponseChunk>(socket, () => {});
  send(socket, { type: 'shutdown' });
  await awaitClose(socket);

  if (pid !== null) await waitForPidExit(pid, SHUTDOWN_PID_WAIT_MS);
  return true;
}

/**
 * No daemon was listening — the ordinary case on a cold machine, not an error worth showing.
 *
 * ```ts
 * import * as Client from './client.ts';
 *
 * const failure = Client.DaemonUnreachable();
 * failure.code; // 'DaemonUnreachable'
 * failure.message; // 'no daemon is listening for this project'
 * ```
 */
export const DaemonUnreachable = Failure.define(
  'DaemonUnreachable',
  'no daemon is listening for this project',
);

/**
 * The daemon accepted the run and then dropped the connection without a terminal message.
 *
 * Previously indistinguishable from a normal failing run: `close` and `error` both
 * `resolve(1)`, exactly like `done` with `exitCode: 1`. A daemon that crashed mid-run was
 * therefore reported to the user — and to CI — as "one test failed", with no hint that no
 * tests had actually been reported at all.
 *
 * ```ts
 * import * as Client from './client.ts';
 *
 * Client.DaemonDisconnected({ reason: 'close' }).message;
 * // 'daemon closed the connection (close) without reporting a result'
 * ```
 */
export const DaemonDisconnected = Failure.define(
  'DaemonDisconnected',
  (data: { reason: 'close' | 'error' }) =>
    `daemon closed the connection (${data.reason}) without reporting a result`,
);

/**
 * Every way a daemon-routed run can fail to produce an exit code.
 *
 * ```ts
 * import * as Client from './client.ts';
 *
 * const failure: Client.RunViaFailure = Client.DaemonDisconnected({ reason: 'error' });
 * failure.code; // 'DaemonDisconnected' — or 'DaemonUnreachable'; narrow with a switch
 * ```
 */
export type RunViaFailure = Failure.Of<typeof DaemonUnreachable | typeof DaemonDisconnected>;

/**
 * Sends `argv` to the daemon and streams its TAP output back to local stdout/stderr.
 * Succeeds with the exit code the daemon reported; fails with one the caller can act on:
 * `DaemonUnreachable` means "fall through to a local run", `DaemonDisconnected` means the
 * daemon died mid-run and the user should be told.
 *
 * A Task rather than a promise of a `Result`, because the two say the same thing and only
 * one of them nests: `Promise<Result<number, E>>` hands the caller a union it must unwrap
 * *inside* whatever it already uses to catch bugs, while `.result()` here produces that union
 * on demand and `await` alone gets the exit code.
 *
 * Not idempotent — it streams a whole test run to stdio — so `retry()` would replay the
 * output. There is nothing here to retry anyway: both failures mean the daemon is gone.
 *
 * Forwards the user's Ctrl+C: client exits with 130; daemon abandons the run cleanly
 * when it sees the socket close (clientAlive=false stops further writes).
 *
 * ```ts
 * import * as Client from './client.ts';
 * import * as Failure from '../../result/failure.ts';
 *
 * // Defined, not invoked: streams the daemon's TAP output to this process's stdio.
 * async function runOnDaemon() {
 *   const outcome = await Client.runVia(['test/foo-test.ts']).result(); // number | RunViaFailure
 *   return Failure.is(outcome) ? null : outcome; // exit code out; a failure the caller acts on
 * }
 * ```
 */
export function runVia(argv: string[]): Task<number, RunViaFailure> {
  return Task(async () => {
    const socket = await tryConnect();
    if (!socket) throw DaemonUnreachable();

    // Per protocol.ts: exactly one terminal message ('done' or 'fatal') ends the
    // stream. close/error here are last-resort fallbacks for a daemon that drops
    // the connection without sending one — reported as declared failures rather than
    // folded into the same exit code a failing test run produces.
    const outcome = new Promise<number>((resolve, reject) => {
      Socket.readMessages<ResponseChunk>(socket, (chunk) => {
        if (chunk.type === 'stdout') process.stdout.write(chunk.data);
        else if (chunk.type === 'stderr') process.stderr.write(chunk.data);
        else if (chunk.type === 'done') resolve(chunk.exitCode);
        else if (chunk.type === 'fatal') {
          // A reported fatal IS a terminal result: the daemon ran, decided the run failed, and
          // said so. That is an exit code, not a transport failure.
          process.stderr.write(`# [qunitx daemon] ${chunk.message}\n`);
          resolve(1);
        }
      });
      socket.once('close', () => reject(DaemonDisconnected({ reason: 'close' })));
      socket.once('error', () => reject(DaemonDisconnected({ reason: 'error' })));
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
      return await outcome;
    } finally {
      process.removeListener('SIGINT', onSigint);
    }
  });
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
  // Reuse the parser's own tokenizer so "how much does a -t/-m value swallow" is decided in one
  // place: a query value or positional input can never be mistaken here for a --watch/--open flag.
  for (const token of Args.tokenize(process.argv.slice(2))) {
    // --search/--print never touches a browser, so routing it through the daemon is pure overhead.
    if (token.kind === 'query') {
      if (token.action === 'list') return false;
      continue;
    }
    if (token.kind !== 'flag') continue;
    if (token.raw === '--no-daemon') return false;
    if (token.raw === '--watch' || token.raw === '-w') return false;
    if (token.raw === '--open' || token.raw === '-o' || token.raw.startsWith('--open=')) {
      return false;
    }
  }
  return true;
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

async function readDaemonPid(cwd: string = process.cwd()): Promise<number | null> {
  try {
    const info = JSON.parse(await fs.readFile(Paths.info(cwd), 'utf8')) as { pid?: unknown };
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
