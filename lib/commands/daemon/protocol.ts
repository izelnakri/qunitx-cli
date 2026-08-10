// NDJSON protocol between daemon client and daemon server.
// One JSON object per line. Client writes a single Request; daemon streams
// any number of stdout/stderr chunks ending with a `done` (or `fatal`) message.
//
// Type-only imports: erased at runtime, so this leaf module stays free of the
// api/ dependency it names in its types.
import type { UserRunOptions } from '../../api/options.ts';
import type { RunResult } from '../../api/run.ts';
import type { ReporterName } from '../../reporters/types.ts';

/**
 * The options a daemon run accepts: everything from {@link UserRunOptions} that survives a socket.
 *
 * A daemon run happens in another process, so a plugin object and a reporter instance cannot come
 * along — they are functions, and functions do not serialize. Rather than accepting them and
 * silently dropping them, they are simply not in this type: the limitation is a compile error at
 * the call site instead of a surprise at run time.
 *
 * `reporter` narrows to the built-in names for the same reason. `console` stays, because it is the
 * *client's* console for the text the daemon streams back — it never crosses.
 *
 * ```ts
 * const options: DaemonRunOptions = { inputs: ['test/'], reporter: 'tap' };
 * options.reporter; // 'tap' — a name, not an instance
 * ```
 */
export interface DaemonRunOptions extends Omit<
  UserRunOptions,
  'reporter' | 'reporters' | 'plugins' | 'open' | 'signal'
> {
  /** One built-in reporter by name, or `false`. An instance cannot cross a socket. */
  reporter?: ReporterName | false;
  /** Several built-in reporters by name. Mutually exclusive with `reporter`, as it is locally. */
  reporters?: ReadonlyArray<ReporterName>;
}

/**
 * Client → daemon: request to execute a test run with the given argv/env in the daemon's persistent Chrome.
 *
 * ```ts
 * const request: RunRequest = {
 *   type: 'run', argv: ['test/foo-test.ts', '--failFast'],
 *   cwd: '/proj', env: { CI: undefined }, nodeVersion: 'v24.14.0',
 * };
 * JSON.stringify(request) + '\n'; // one NDJSON line, ready for the socket
 * ```
 */
export interface RunRequest {
  /** Discriminator for the protocol union; always `'run'` for this variant. */
  type: 'run';
  /** CLI arguments after `qunitx` (i.e. `process.argv.slice(2)`). */
  argv: string[];
  /**
   * Resolved options, when the request came from the JS API rather than a command line. Present
   * means "build the config from these and answer with a `result` chunk"; absent means the
   * daemon parses `argv` exactly as the CLI would.
   *
   * Only what survives JSON is here — no plugin objects, no reporter instances, no callbacks.
   * {@link DaemonRunOptions} is the type that enforces that at the call site rather than
   * discovering it at the socket.
   */
  options?: DaemonRunOptions;
  /** Client's working directory. The daemon rejects mismatched cwds (different project). */
  cwd: string;
  /** Client's full process environment, applied to the run and restored on completion. */
  env: Record<string, string | undefined>;
  /** Client's `process.version`. The daemon shuts down on mismatch to avoid module-graph drift. */
  nodeVersion: string;
}

/**
 * Client → daemon: liveness/identity probe.
 *
 * ```ts
 * const ping: PingRequest = { type: 'ping' };
 * ping.type; // 'ping' — the daemon answers with a `pong` chunk
 * ```
 */
export interface PingRequest {
  /** Discriminator; always `'ping'`. */
  type: 'ping';
}

/**
 * Client → daemon: graceful shutdown request.
 *
 * ```ts
 * const request: ShutdownRequest = { type: 'shutdown' };
 * request.type; // 'shutdown' — acked with `done`, then the daemon exits
 * ```
 */
export interface ShutdownRequest {
  /** Discriminator; always `'shutdown'`. */
  type: 'shutdown';
}

/**
 * Discriminated union of every request the daemon accepts.
 *
 * ```ts
 * const req: Request = { type: 'ping' };
 * req.type; // 'ping' — the daemon's dispatch switches on this discriminant
 * ```
 */
export type Request = RunRequest | PingRequest | ShutdownRequest;

/**
 * Daemon → client: one streamed response chunk in the per-request stream.
 *
 * ```ts
 * const chunks: ResponseChunk[] = [
 *   { type: 'stdout', data: 'ok 1 Cart: checkout\n' },
 *   { type: 'done', exitCode: 0 }, // exactly one terminal chunk ends the stream
 * ];
 * chunks[1].type; // 'done'
 * ```
 */
export type ResponseChunk =
  /** Forwarded `process.stdout.write` chunk from the run. */
  | { type: 'stdout'; data: string }
  /** The run's structured result; sent just before `done`, only for an options-driven request. */
  | { type: 'result'; result: RunResult }
  /** Forwarded `process.stderr.write` chunk from the run. */
  | { type: 'stderr'; data: string }
  /** Reply to a `PingRequest` with daemon identity + uptime fields. */
  | { type: 'pong'; pid: number; nodeVersion: string; cwd: string; startedAt: number }
  /** Terminal message of a successful run; carries the captured exit code. */
  | { type: 'done'; exitCode: number }
  /** Terminal message of a failed run (validation error, internal exception, or pre-shutdown notify). */
  | { type: 'fatal'; message: string };

/**
 * Sidecar JSON file written next to the socket; lets `daemon status` show details without an IPC roundtrip.
 *
 * ```ts
 * const info: DaemonInfo = {
 *   pid: 4242, socketPath: '/tmp/qunitx-daemon-ab12cd34ef56.sock',
 *   cwd: '/proj', nodeVersion: 'v24.14.0', startedAt: 1_760_000_000_000,
 * };
 * info.pid; // 4242 — polled with `process.kill(pid, 0)` after `daemon stop`
 * ```
 */
export interface DaemonInfo {
  /** OS process id of the running daemon. */
  pid: number;
  /** Absolute path to the daemon's listening Unix socket. */
  socketPath: string;
  /** Working directory the daemon was started in (matches its socket-path hash). */
  cwd: string;
  /** Daemon's `process.version` at startup. */
  nodeVersion: string;
  /** Epoch ms when the daemon began listening. */
  startedAt: number;
}
