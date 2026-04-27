// NDJSON protocol between daemon client and daemon server.
// One JSON object per line. Client writes a single Request; daemon streams
// any number of stdout/stderr chunks ending with a `done` (or `fatal`) message.

/** Client → daemon: request to execute a test run with the given argv/env in the daemon's persistent Chrome. */
export interface RunRequest {
  /** Discriminator for the protocol union; always `'run'` for this variant. */
  type: 'run';
  /** CLI arguments after `qunitx` (i.e. `process.argv.slice(2)`). */
  argv: string[];
  /** Client's working directory. The daemon rejects mismatched cwds (different project). */
  cwd: string;
  /** Client's full process environment, applied to the run and restored on completion. */
  env: Record<string, string | undefined>;
  /** Client's `process.version`. The daemon shuts down on mismatch to avoid module-graph drift. */
  nodeVersion: string;
}

/** Client → daemon: liveness/identity probe. */
export interface PingRequest {
  /** Discriminator; always `'ping'`. */
  type: 'ping';
}

/** Client → daemon: graceful shutdown request. */
export interface ShutdownRequest {
  /** Discriminator; always `'shutdown'`. */
  type: 'shutdown';
}

/** Discriminated union of every request the daemon accepts. */
export type Request = RunRequest | PingRequest | ShutdownRequest;

/** Daemon → client: one streamed response chunk in the per-request stream. */
export type ResponseChunk =
  /** Forwarded `process.stdout.write` chunk from the run. */
  | { type: 'stdout'; data: string }
  /** Forwarded `process.stderr.write` chunk from the run. */
  | { type: 'stderr'; data: string }
  /** Reply to a `PingRequest` with daemon identity + uptime fields. */
  | { type: 'pong'; pid: number; nodeVersion: string; cwd: string; startedAt: number }
  /** Terminal message of a successful run; carries the captured exit code. */
  | { type: 'done'; exitCode: number }
  /** Terminal message of a failed run (validation error, internal exception, or pre-shutdown notify). */
  | { type: 'fatal'; message: string };

/** Sidecar JSON file written next to the socket; lets `daemon status` show details without an IPC roundtrip. */
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
