import net from 'node:net';
import { existsSync } from 'node:fs';
import * as Paths from './paths.ts';
import { CLEANUP_GRACE_MS } from '../../utils/close-with-grace.ts';
import * as Args from '../../args/index.ts';
import * as Socket from './socket.ts';
import { Failure } from '../../result/index.ts';
import { Task } from '../../task/index.ts';
import { readJsonCache } from '../../utils/read-json-cache.ts';
import { processConsole, type Console } from '../../console.ts';
import type { DaemonRunOptions } from './protocol.ts';
import type { RunResult } from '../../api/run.ts';
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
export const DaemonUnreachable: Failure.FailureFactory<'DaemonUnreachable', undefined> &
  ((
    data?: undefined,
    options?: Failure.FailureOptions,
  ) => Failure.Failure<'DaemonUnreachable', undefined>) = Failure.define(
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
export const DaemonDisconnected: Failure.FailureFactory<
  'DaemonDisconnected',
  { reason: 'close' | 'error' | 'no-result' }
> = Failure.define(
  'DaemonDisconnected',
  // 'no-result' is the version-skew case: a daemon older than the client answered an
  // options-driven request without the `result` chunk that request is defined by.
  (data: { reason: 'close' | 'error' | 'no-result' }) =>
    `daemon closed the connection (${data.reason}) without reporting a result`,
);

/**
 * The daemon accepted the connection and then said nothing for {@link RUN_SILENCE_TIMEOUT_MS}.
 *
 * `dispatchRun` settles on a terminal `done`/`fatal` chunk, or on the socket closing. A daemon
 * wedged mid-run sends neither, and the client waited forever: no output, no error, a terminal
 * that never comes back. CI saw the same shape as an empty stdout and a harness SIGTERM.
 *
 * Measured on silence rather than total duration, because a long suite is not a wedged one — the
 * daemon streams a chunk per test, so any run making progress keeps resetting the clock.
 *
 * ```ts
 * import * as Client from './client.ts';
 *
 * Client.DaemonSilent({ ms: 240_000 }).message;
 * // 'daemon accepted the run but sent nothing for 240s — it is wedged, not slow'
 * ```
 */
export const DaemonSilent: Failure.FailureFactory<'DaemonSilent', { ms: number }> = Failure.define(
  'DaemonSilent',
  (data: { ms: number }) =>
    `daemon accepted the run but sent nothing for ` +
    `${data.ms < 1000 ? `${data.ms}ms` : `${Math.round(data.ms / 1000)}s`} — ` +
    `it is wedged, not slow. Run \`qunitx daemon stop\` and retry, or pass --no-daemon.`,
);

/**
 * How long the client waits on total silence before declaring the daemon wedged.
 *
 * Above the daemon's own per-group deadline (`GROUP_TIMEOUT_MS`, 180s): while a group runs down
 * that clock the daemon is legitimately quiet, and giving up first would turn a run the daemon was
 * about to fail properly into a transport error. `QUNITX_DAEMON_RUN_TIMEOUT` overrides it, in ms —
 * the regression test uses a small value to prove the path without waiting minutes.
 *
 * ```ts
 * import * as Client from './client.ts';
 *
 * Client.RUN_SILENCE_TIMEOUT_MS > 180_000; // true — the daemon gets to report first
 * ```
 */
export const RUN_SILENCE_TIMEOUT_MS = 240_000;

function silenceBudget(): number {
  const override = Number(process.env.QUNITX_DAEMON_RUN_TIMEOUT);
  return Number.isFinite(override) && override > 0 ? override : RUN_SILENCE_TIMEOUT_MS;
}

/**
 * Every way a daemon-routed run can fail to produce an exit code.
 *
 * ```ts
 * import * as Client from './client.ts';
 *
 * const failure: Client.DaemonRunFailure = Client.DaemonDisconnected({ reason: 'error' });
 * failure.code; // 'DaemonDisconnected' — or 'DaemonUnreachable'; narrow with a switch
 * ```
 */
export type DaemonRunFailure = Failure.Of<
  typeof DaemonUnreachable | typeof DaemonDisconnected | typeof DaemonSilent
>;

/**
 * The CLI's path: sends raw `argv` and answers with the exit code the daemon reported.
 *
 * Exists as its own entry point so that argv is parsed on the DAEMON. `Args.parse` needs a
 * project root, so converting argv into {@link DaemonRunOptions} here would make every
 * daemon-routed `qunitx` load `setup/config.ts` and its `find-project-root`/`fs-tree` chain —
 * measured at ~48 ms of module evaluation (63 ms -> 111 ms), against the ~800 ms the daemon
 * saves. {@link run} is the one to reach for otherwise; this trades a narrower answer for the
 * startup latency the daemon exists to protect.
 *
 * A Task rather than a promise of a `Result`, because the two say the same thing and only one of
 * them nests: `await` alone gets the exit code, `.result()` gets the union. Not idempotent — it
 * streams a whole test run to stdio — and nothing here is worth retrying, since both failures
 * mean the daemon is gone. Forwards Ctrl+C: the client exits 130 and the daemon abandons the run
 * when it sees the socket close.
 *
 * ```ts
 * import * as Client from './client.ts';
 * import * as Failure from '../../result/failure.ts';
 *
 * // Defined, not invoked: streams the daemon's TAP output to this process's stdio.
 * async function runOnDaemon() {
 *   const outcome = await Client.runArgv(['test/foo-test.ts']).result(); // number | DaemonRunFailure
 *   return Failure.is(outcome) ? null : outcome; // exit code out; a failure the caller acts on
 * }
 * ```
 */
export function runArgv(argv: string[]): Task<number, DaemonRunFailure> {
  return Task(async () => (await dispatchRun({ argv })).exitCode);
}

/**
 * Runs the suite inside the daemon and answers with the same {@link RunResult} a local run
 * produces. The one to reach for; {@link runArgv} is the CLI's narrower variant.
 *
 * Streams the daemon's text into `console` when one is given, so a caller that asked for a
 * reporter still sees its output locally, and reads the `result` chunk the daemon sends just
 * before `done`.
 *
 * ```ts
 * import * as Client from './client.ts';
 * import * as Failure from '../../result/failure.ts';
 *
 * // Defined, not invoked: dispatches a real run to the project's daemon.
 * async function runOnDaemon() {
 *   const outcome = await Client.run({ inputs: ['test/'] }).result();
 *   return Failure.is(outcome) ? null : outcome.counts;
 * }
 * ```
 */
export function run(options: DaemonRunOptions, sink?: Console): Task<RunResult, DaemonRunFailure> {
  return Task(async () => {
    // `console` is the CLIENT's, for the text streamed back — an object carrying functions, so it
    // does not survive `JSON.stringify`. Sent anyway, the daemon received `{}`, built a `Console`
    // whose `log` was `undefined`, and died on the first call — taking the daemon down and every
    // run queued behind it. Dropped here, at the one place that knows which half of the options
    // crosses the socket.
    const { console: _console, ...overWire } = options;
    const { result } = await dispatchRun({ options: overWire, sink });
    // The daemon sends `result` before `done` on every options-driven request, so its absence
    // means the daemon answered a request it did not understand — a version skew between a
    // running daemon and a newer client, which is exactly the case `fatal` cannot describe.
    if (!result) throw DaemonDisconnected({ reason: 'no-result' });

    return result;
  });
}

/**
 * One run over the socket. {@link runArgv} sends an argv and wants an exit code, {@link run}
 * sends options and wants a {@link RunResult}; everything between those two ends — connect,
 * SIGINT forwarding, the terminal chunk, the two ways a daemon can vanish — is identical, and
 * lives here.
 */
function dispatchRun({
  argv = [],
  options,
  sink,
}: {
  argv?: string[];
  options?: DaemonRunOptions;
  sink?: Console;
}): Promise<{ exitCode: number; result: RunResult | null }> {
  return (async () => {
    const socket = await tryConnect();
    if (!socket) throw DaemonUnreachable();
    const out = sink ?? processConsole;
    let result: RunResult | null = null;

    // Per protocol.ts: exactly one terminal message ('done' or 'fatal') ends the
    // stream. close/error here are last-resort fallbacks for a daemon that drops
    // the connection without sending one — reported as declared failures rather than
    // folded into the same exit code a failing test run produces.
    const outcome = new Promise<number>((resolve, reject) => {
      // Reset by every chunk, so a run that is merely long never trips it; only a daemon that has
      // stopped talking does. Without this the promise has no losing branch at all: a wedged
      // daemon leaves the CLI waiting with no output and no error, forever.
      const budget = silenceBudget();
      let silence: ReturnType<typeof setTimeout>;
      const heard = () => {
        clearTimeout(silence);
        silence = setTimeout(() => {
          socket.destroy();
          reject(DaemonSilent({ ms: budget }));
        }, budget);
        silence.unref?.();
      };
      const settle = (finish: () => void) => {
        clearTimeout(silence);
        finish();
      };
      heard();

      Socket.readMessages<ResponseChunk>(socket, (chunk) => {
        heard();
        if (chunk.type === 'stdout') out.log(chunk.data);
        else if (chunk.type === 'stderr') out.error(chunk.data);
        else if (chunk.type === 'result') result = chunk.result;
        else if (chunk.type === 'done') settle(() => resolve(chunk.exitCode));
        else if (chunk.type === 'fatal') {
          // A reported fatal IS a terminal result: the daemon ran, decided the run failed, and
          // said so. That is an exit code, not a transport failure.
          out.error(`# [qunitx daemon] ${chunk.message}\n`);
          settle(() => resolve(1));
        }
      });
      socket.once('close', () => settle(() => reject(DaemonDisconnected({ reason: 'close' }))));
      socket.once('error', () => settle(() => reject(DaemonDisconnected({ reason: 'error' }))));
    });

    const onSigint = () => {
      socket.end();
      process.exit(SIGINT_EXIT_CODE);
    };
    process.once('SIGINT', onSigint);

    send(socket, {
      type: 'run',
      argv,
      options,
      cwd: process.cwd(),
      env: { ...process.env },
      nodeVersion: process.version,
    });

    try {
      return { exitCode: await outcome, result };
    } finally {
      process.removeListener('SIGINT', onSigint);
    }
  })();
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

// No info file, a torn one, or one without a pid are the same answer: no daemon here — which is
// exactly what readJsonCache says, so this only has to name the shape it wants and read the field.
function readDaemonPid(cwd: string = process.cwd()): Task<number | null, never> {
  return readJsonCache(Paths.info(cwd), hasPid).map((info) => info?.pid ?? null);
}

function hasPid(value: unknown): value is { pid: number } {
  return typeof (value as { pid?: unknown })?.pid === 'number';
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
