import * as Client from '../commands/daemon/client.ts';
import * as Daemon from '../commands/daemon/index.ts';
import * as Paths from '../commands/daemon/paths.ts';
import { Task } from '../task/index.ts';
import type { DaemonRunOptions } from '../commands/daemon/protocol.ts';
import type { RunResult } from './run.ts';

// Defined with the wire contract, because that is exactly why it is narrower than
// `UserRunOptions`: it is `UserRunOptions` minus everything that cannot cross a socket.
export type { DaemonRunOptions } from '../commands/daemon/protocol.ts';
/** Why a daemon run could not happen: the daemon was unreachable, or it died mid-run. */
export type { DaemonRunFailure } from '../commands/daemon/client.ts';

/**
 * A live daemon, as reported by {@link status}.
 *
 * ```ts
 * const info: DaemonStatus = {
 *   running: true, pid: 4242, cwd: '/proj',
 *   nodeVersion: 'v24.14.0', startedAt: 1_760_000_000_000, socketPath: '/tmp/qunitx-…sock',
 * };
 * info.running; // true — the other fields are absent when it is false
 * ```
 */
export type DaemonStatus =
  | { running: false }
  | {
      /** A daemon answered the probe. */
      running: true;
      /** Its process id. */
      pid: number;
      /** The project directory it serves. Only runs from this directory may use it. */
      cwd: string;
      /** The Node version it is running; a client on a different one is refused. */
      nodeVersion: string;
      /** Epoch ms when it began listening. */
      startedAt: number;
      /** The Unix socket (or Windows named pipe) it listens on. */
      socketPath: string;
    };

/**
 * Ensures a daemon is running for this project, spawning one if there isn't.
 *
 * The daemon holds a browser and a warm esbuild context between runs, which is worth roughly
 * 800 ms per run — so it pays for itself the second time a long-lived process runs the suite.
 *
 * Idempotent: with one already up, this is a liveness probe and nothing is spawned.
 *
 * ```ts
 * import { start } from './daemon.ts';
 *
 * // Defined, not invoked: may spawn a real background process.
 * async function warmUp() {
 *   return await start(); // true once a daemon is reachable
 * }
 * ```
 */
export function start(): Task<boolean, never> {
  return Task(() => Daemon.ensureRunning());
}

/**
 * Stops this project's daemon. Resolves `true` if one was running, `false` if there was nothing
 * to stop — either way, no daemon is running afterwards.
 *
 * ```ts
 * import { stop } from './daemon.ts';
 *
 * // Defined, not invoked: shuts down a real background process.
 * async function coolDown() {
 *   return await stop(); // false when none was running
 * }
 * ```
 */
export function stop(): Task<boolean, never> {
  return Task(() => Client.shutdown());
}

/**
 * Probes this project's daemon. An actual round-trip over the socket, not a look at the sentinel
 * file, so a crashed daemon that left its files behind reports `{ running: false }`.
 *
 * ```ts
 * import { status } from './daemon.ts';
 *
 * // Defined, not invoked: opens a real socket connection.
 * async function uptimeMinutes() {
 *   const info = await status();
 *   return info.running ? Math.round((Date.now() - info.startedAt) / 60_000) : null;
 * }
 * ```
 */
export function status(): Task<DaemonStatus, never> {
  return Task(async () => {
    const pong = await Client.ping();
    if (pong?.type !== 'pong') return { running: false as const };

    return {
      running: true as const,
      pid: pong.pid,
      cwd: pong.cwd,
      nodeVersion: pong.nodeVersion,
      startedAt: pong.startedAt,
      socketPath: Paths.socket(pong.cwd),
    };
  });
}

/**
 * Runs the suite inside this project's daemon and resolves with the same {@link RunResult} a
 * local run would produce — reusing the daemon's browser and warm bundle instead of paying for
 * a fresh one.
 *
 * Spawns the daemon if one isn't running, so a first call is not measurably faster than
 * {@link run}; every call after it is.
 *
 * {@link DaemonRunOptions} is narrower than the local `UserRunOptions` by exactly what cannot cross
 * a process boundary: plugin objects and reporter instances. `console` still works — the daemon's
 * text is streamed back and written there.
 *
 * ```ts
 * import { run as runOnDaemon } from './daemon.ts';
 *
 * // Defined, not invoked: dispatches a real run to the daemon.
 * async function fastCheck() {
 *   const result = await runOnDaemon({ inputs: ['test/'] });
 *   return result.ok;
 * }
 * ```
 */
export function run(options: DaemonRunOptions = {}): Task<RunResult, Client.DaemonRunFailure> {
  return Task(async () => {
    // The boolean matters: `ensureRunning` returns false when the spawn never became reachable
    // within its budget. Proceeding anyway meant dialling a socket that certainly is not there
    // and reporting `DaemonUnreachable` a connect-timeout later — the same failure, minutes
    // after it was already known.
    if (!(await Daemon.ensureRunning())) throw Client.DaemonUnreachable();
    return await Client.run(options, options.console);
  });
}
