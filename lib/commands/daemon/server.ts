import net from 'node:net';
import fs from 'node:fs';
import { writeFile, unlink, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { daemonSocketPath, daemonInfoPath } from '../../utils/daemon-socket-path.ts';
import { parseDaemonIdleTimeout } from '../../utils/parse-daemon-idle-timeout.ts';
import { attachLineParser, probeSocket } from './socket-utils.ts';
import { setupConfig } from '../../setup/config.ts';
import { launchBrowser } from '../../setup/browser.ts';
import { DaemonRunError } from '../run/tests-in-browser.ts';
import { run } from '../run.ts';
import type { Request, ResponseChunk, RunRequest, DaemonInfo } from './protocol.ts';
import type { Browser } from 'playwright-core';
import type { Config } from '../../types.ts';

// Daemon idle window: after the last run finishes, the daemon shuts itself down.
// Default 30 minutes; override with `QUNITX_DAEMON_IDLE_TIMEOUT` (see
// `parseDaemonIdleTimeout`). `Infinity` ⇒ no auto-shutdown — `resetIdleTimer` skips
// arming the timer in that case. Read once at startup so a running daemon's lifetime
// is fixed by the env at spawn time. The CLI side validates and warns separately,
// so any warning here would only land in QUNITX_DAEMON_LOG (or be lost).
const IDLE_TIMEOUT_MS = parseDaemonIdleTimeout(process.env.QUNITX_DAEMON_IDLE_TIMEOUT).ms;
// Liveness probe ceiling: if a stale socket file's owning process is gone, connect()
// returns ECONNREFUSED almost immediately; the timeout only kicks in when the OS is
// momentarily slow.
const LIVENESS_PROBE_TIMEOUT_MS = 500;
// After this many back-to-back browser crashes (no successful run between), the daemon
// gives up rather than entering a relaunch loop. Two attempts catches the common case
// (one transient crash followed by recovery) without papering over a broken environment.
const MAX_CONSECUTIVE_CRASHES = 2;

interface DaemonState {
  browser: Browser;
  /** Captured at startup; used to relaunch the browser on crash recovery. */
  baseConfig: Config;
  cwd: string;
  startedAt: number;
  pkgMtime: number;
  // Serial run mutex. Each run waits for the previous one to fully resolve before
  // starting; the daemon does not multiplex Chrome across simultaneous runs.
  runQueue: Promise<unknown>;
  shuttingDown: boolean;
  pendingClients: Set<net.Socket>;
  socketServer: net.Server;
  idleTimer: NodeJS.Timeout | null;
  socketPath: string;
  infoPath: string;
  /** Reset to 0 after any run that left the browser connected. */
  consecutiveCrashes: number;
  /**
   * `true` after `listen()` resolves. Gates file cleanup in `shutdownDaemon`: a
   * process whose `listen()` failed (concurrent-spawn EADDRINUSE) does not own the
   * socket or info file, so the loser must not unlink them — only the winner does.
   */
  listenSucceeded: boolean;
  /**
   * Single-source esbuild incremental-context cache, persisted across daemon runs.
   * Mutated by reference inside `buildIncrementally`; disposed on daemon shutdown.
   */
  esbuildCache: NonNullable<Config['_daemonEsbuildCache']>;
}

/**
 * Daemon process entry point. Owns one persistent Chrome and one Unix socket; serves
 * `run` requests serially. Shuts down on SIGTERM/SIGINT, idle timeout, package.json
 * mutation, node version mismatch, or an explicit `shutdown` request.
 */
export async function runDaemonServer(): Promise<void> {
  const cwd = process.cwd();
  const socketPath = daemonSocketPath(cwd);
  const infoPath = daemonInfoPath(cwd);

  // Race-resolution: if a live daemon already runs for this cwd, the new daemon exits
  // 0 so the client (which polls for socket availability) attaches to the winner.
  // Use the info file as the presence check: existsSync(socketPath) is unreliable on
  // Windows (named pipes don't appear on the regular filesystem). isLiveSocket actively
  // probes via net.createConnection, which works on every platform.
  if (fs.existsSync(infoPath) && (await isLiveSocket(socketPath))) process.exit(0);
  // Stale socket from a previous crash — must be removed before listen() (POSIX only;
  // Windows named pipes auto-recycle, and unlink on a pipe path is a no-op error we ignore).
  await unlink(socketPath).catch(() => {});

  // Optional debug log: when QUNITX_DAEMON_LOG=<path> is set, redirect the daemon's
  // stdout+stderr to that file so idle/startup/shutdown events (otherwise lost to
  // the spawn's stdio:'ignore') become inspectable. Buffered async writes via
  // createWriteStream; log-stream errors are swallowed so a broken log path can
  // never crash the daemon. handleRun's per-run interceptor still works: it captures
  // whichever write fn is current at run start, so during runs stdout flows to the
  // client and reverts to the log fn afterwards.
  const logPath = process.env.QUNITX_DAEMON_LOG;
  if (logPath) {
    const log = fs.createWriteStream(logPath, { flags: 'a' });
    log.on('error', () => {});
    const forward = log.write.bind(log) as typeof process.stdout.write;
    process.stdout.write = forward;
    process.stderr.write = forward;
  }

  // setupConfig reads process.argv directly; the daemon's actual argv is `daemon _serve`
  // which would be parsed as test paths. Strip it for the startup config — we only need
  // the browser type here. Per-run argv comes from the client via runOnce.
  const argvSnapshot = process.argv;
  process.argv = [argvSnapshot[0], argvSnapshot[1] ?? 'cli.ts'];
  let baseConfig;
  try {
    baseConfig = await setupConfig();
  } finally {
    process.argv = argvSnapshot;
  }
  baseConfig._daemonMode = true;
  baseConfig.watch = false;
  baseConfig.open = false;

  const [browser, pkgMtime] = await Promise.all([launchBrowser(baseConfig), readPkgMtime(cwd)]);

  const state: DaemonState = {
    browser,
    baseConfig,
    cwd,
    startedAt: Date.now(),
    pkgMtime,
    runQueue: Promise.resolve(),
    shuttingDown: false,
    pendingClients: new Set(),
    socketServer: null as unknown as net.Server,
    idleTimer: null,
    socketPath,
    infoPath,
    consecutiveCrashes: 0,
    listenSucceeded: false,
    esbuildCache: { _esbuildContext: null },
  };

  const shutdown = (reason: string) => shutdownDaemon(state, reason);
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  // Any unhandled rejection corrupts shared browser state — die so the next client respawns.
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`# [qunitx daemon] unhandledRejection: ${err}\n`);
    void shutdown('unhandledRejection');
  });

  state.socketServer = net.createServer((socket) => handleConnection(socket, state));
  state.socketServer.on('error', (err) => {
    process.stderr.write(`# [qunitx daemon] server error: ${err.message}\n`);
    void shutdown('server error');
  });

  // listen() is the atomic at-most-one-daemon claim — only one process can bind to
  // the socket path. Once it returns, we know we own the daemon role and can publish
  // the info file with our identity. Writing the info file BEFORE listen would let
  // a losing concurrent-spawn process overwrite the winner's info with its own pid,
  // then unlink it on its own EADDRINUSE — leaving the winner with corrupted or
  // missing presence state. The client's spawn-poll waits for both info file
  // existence AND a successful ping, so the brief gap between listen() returning
  // and writeFile resolving is bridged on the client side, not the server.
  await listen(state.socketServer, socketPath);
  // Set the ownership flag in the same microtask as listen()'s resolution. Signals
  // are delivered as macrotasks; they cannot interleave between two synchronous
  // statements, so this flag is observed atomically with bind success.
  state.listenSucceeded = true;
  // chmod after listen — listen creates the socket file with the default umask, which
  // can leave it world-readable. Skipped on Windows: named pipe paths don't accept
  // POSIX modes and chmod returns EPERM/EINVAL for them.
  if (process.platform !== 'win32') await chmod(socketPath, 0o600).catch(() => {});

  const info: DaemonInfo = {
    pid: process.pid,
    socketPath,
    cwd,
    nodeVersion: process.version,
    startedAt: state.startedAt,
  };
  await writeFile(infoPath, JSON.stringify(info, null, 2));

  resetIdleTimer(state);
  process.stderr.write(`# [qunitx daemon] listening on ${socketPath} (pid ${process.pid})\n`);

  // Block forever. The socket server keeps the event loop alive; the daemon exits via
  // process.exit() inside shutdownDaemon (signal, idle timeout, or shutdown request).
  // Without this, runDaemonServer would resolve, runServeMode would return 0, and cli.ts
  // would call process.exit(0), killing the daemon as soon as it finished listening.
  return new Promise<void>(() => {});
}

function listen(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

async function shutdownDaemon(state: DaemonState, reason: string): Promise<void> {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  process.stderr.write(`# [qunitx daemon] shutting down: ${reason}\n`);

  if (state.idleTimer) clearTimeout(state.idleTimer);

  // Notify pending clients so they fall back to a local run rather than hanging.
  for (const sock of state.pendingClients) {
    writeChunk(sock, { type: 'fatal', message: `daemon shutting down: ${reason}` });
    sock.end();
  }

  await new Promise<void>((resolve) => state.socketServer.close(() => resolve()));
  // Only unlink files this process actually owns. A daemon whose listen() failed
  // (concurrent-spawn race: lost to EADDRINUSE) reaches this path via unhandled-
  // Rejection but doesn't own the socket/info — unlinking corrupts the winner.
  await Promise.all([
    state.listenSucceeded ? unlink(state.socketPath).catch(() => {}) : null,
    state.listenSucceeded ? unlink(state.infoPath).catch(() => {}) : null,
    state.browser.close().catch(() => {}),
    state.esbuildCache._esbuildContext?.dispose().catch(() => {}),
  ]);
  process.exit(0);
}

function resetIdleTimer(state: DaemonState): void {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  // QUNITX_DAEMON_IDLE_TIMEOUT=false → Infinity → no auto-shutdown. Skip setTimeout
  // entirely: Node clamps any delay > 2^31-1 ms (~24.8 days) to 1 ms, so passing
  // Infinity would fire the shutdown almost immediately — the opposite of "never".
  if (!Number.isFinite(IDLE_TIMEOUT_MS)) return;
  // unref so the timer itself doesn't keep the event loop alive — the socket server
  // is the only ref'd handle. When the timer fires, shutdown closes the server, the
  // loop drains, and the process exits cleanly.
  state.idleTimer = setTimeout(() => void shutdownDaemon(state, 'idle timeout'), IDLE_TIMEOUT_MS);
  state.idleTimer.unref();
}

function handleConnection(socket: net.Socket, state: DaemonState): void {
  state.pendingClients.add(socket);
  socket.on('close', () => state.pendingClients.delete(socket));
  // Without this handler, EPIPE from the client disconnecting crashes the daemon.
  socket.on('error', () => {});
  attachLineParser<Request>(socket, (req) => void dispatch(req, socket, state));
}

async function dispatch(req: Request, socket: net.Socket, state: DaemonState): Promise<void> {
  if (req.type === 'ping') {
    writeChunk(socket, {
      type: 'pong',
      pid: process.pid,
      nodeVersion: process.version,
      cwd: state.cwd,
      startedAt: state.startedAt,
    });
    socket.end();
  } else if (req.type === 'shutdown') {
    // Synchronously remove the info file before acking so its absence is a reliable
    // "daemon is gone" signal at the moment the client returns. shutdownDaemon's
    // own async unlink is then a no-op (catch'd ENOENT).
    try {
      fs.unlinkSync(state.infoPath);
    } catch {
      /* already gone */
    }
    writeChunk(socket, { type: 'done', exitCode: 0 });
    socket.end();
    void shutdownDaemon(state, 'shutdown request');
  } else if (req.type === 'run') {
    state.runQueue = state.runQueue.then(() => handleRun(req, socket, state));
    await state.runQueue;
  }
}

function writeChunk(socket: net.Socket, chunk: ResponseChunk): void {
  if (socket.destroyed) return;
  try {
    socket.write(JSON.stringify(chunk) + '\n');
  } catch {
    /* peer gone — handled via `clientAlive` flag in handleRun */
  }
}

/**
 * Builds a `process.stdout.write`-compatible interceptor that forwards every chunk
 * to the client over the socket while preserving the optional callback contract.
 * Skips the toString + writeChunk hop entirely once the socket is destroyed —
 * `socket.destroyed` flips at the moment the 'close' event fires, so this is the
 * direct equivalent of a `clientAlive` flag without the mutation.
 */
function makeInterceptor(
  socket: net.Socket,
  type: 'stdout' | 'stderr',
): typeof process.stdout.write {
  return ((chunk: unknown, ...args: unknown[]): boolean => {
    if (!socket.destroyed) {
      const str = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
      writeChunk(socket, { type, data: str });
    }
    const cb = args[args.length - 1];
    if (typeof cb === 'function') queueMicrotask(cb as () => void);
    return true;
  }) as typeof process.stdout.write;
}

async function handleRun(req: RunRequest, socket: net.Socket, state: DaemonState): Promise<void> {
  if (state.shuttingDown) {
    writeChunk(socket, { type: 'fatal', message: 'daemon shutting down' });
    return void socket.end();
  } else if (req.cwd !== state.cwd) {
    writeChunk(socket, {
      type: 'fatal',
      message: `cwd mismatch: daemon=${state.cwd} client=${req.cwd}`,
    });
    return void socket.end();
  } else if (req.nodeVersion !== process.version) {
    writeChunk(socket, {
      type: 'fatal',
      message: `node version mismatch: daemon=${process.version} client=${req.nodeVersion}`,
    });
    socket.end();
    return void shutdownDaemon(state, 'node version mismatch');
  }
  // Detect package.json mutation: stale config means stale extensions/browser/timeout.
  const currentMtime = await readPkgMtime(state.cwd);
  if (currentMtime !== state.pkgMtime) {
    writeChunk(socket, { type: 'fatal', message: 'package.json changed; restarting daemon' });
    socket.end();
    return void shutdownDaemon(state, 'package.json changed');
  }

  if (state.idleTimer) clearTimeout(state.idleTimer);

  // Pre-flight browser check: relaunch if it died while the daemon was idle. Skipping
  // this would let the run hang inside Playwright's CDP send waiting for responses
  // from a dead Chrome until its 30s timeout fires.
  if (!state.browser.isConnected()) {
    await recoverBrowser(state);
    if (state.shuttingDown) {
      writeChunk(socket, { type: 'fatal', message: 'browser recovery failed' });
      return void socket.end();
    }
  }

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = makeInterceptor(socket, 'stdout');
  process.stderr.write = makeInterceptor(socket, 'stderr');

  let exitCode = 0;
  try {
    exitCode = await runOnce(req.argv, req.env, state);
  } catch (err) {
    process.stderr.write = origStderrWrite;
    origStderrWrite(`# [qunitx daemon] run error: ${(err as Error).stack || err}\n`);
    if (!socket.destroyed)
      writeChunk(socket, { type: 'fatal', message: (err as Error).message || String(err) });
    exitCode = 1;
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  }

  // Browser-crash recovery: relaunch the persistent browser if it died this run.
  if (state.browser.isConnected()) state.consecutiveCrashes = 0;
  else await recoverBrowser(state);

  if (!socket.destroyed) {
    writeChunk(socket, { type: 'done', exitCode });
    socket.end();
  }
  resetIdleTimer(state);
}

/**
 * Relaunches the daemon's persistent browser after a crash. Bounded by
 * `MAX_CONSECUTIVE_CRASHES` so a broken environment shuts the daemon down instead of
 * looping forever — the next client respawns a fresh daemon.
 */
async function recoverBrowser(state: DaemonState): Promise<void> {
  if (++state.consecutiveCrashes > MAX_CONSECUTIVE_CRASHES) {
    return void shutdownDaemon(state, `${state.consecutiveCrashes} consecutive browser crashes`);
  }
  process.stderr.write(
    `# [qunitx daemon] browser crashed; relaunching (${state.consecutiveCrashes}/${MAX_CONSECUTIVE_CRASHES})\n`,
  );
  // Fire-and-forget close on the dead handle — awaiting browser.close() on a torn-down
  // CDP socket hangs forever waiting for a protocol reply that never arrives.
  // skipPrelaunch=true bypasses the singleton prelaunch endpoint (which now points at the
  // dead Chrome) and goes straight to a fresh chromium.launch().
  state.browser.close().catch(() => {});
  try {
    state.browser = await launchBrowser(state.baseConfig, true);
  } catch (err) {
    void shutdownDaemon(state, `browser relaunch failed: ${(err as Error).message || err}`);
  }
}

/**
 * Performs one test run inside the daemon by delegating to `run()` — the same code
 * path local non-watch invocations use, but with `_daemonMode` set so it reuses the
 * daemon's persistent browser and throws `DaemonRunError` instead of `process.exit`.
 * Concurrent group orchestration, timing-cache persistence, and after-hook all come
 * for free from the shared run pipeline.
 */
async function runOnce(
  argv: string[],
  env: Record<string, string | undefined>,
  state: DaemonState,
): Promise<number> {
  // Snapshot env + argv, swap in client values, restore on exit. Snapshot is also the
  // baseline so before-hook env mutations don't bleed across runs.
  const envSnapshot = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  const argvSnapshot = process.argv;
  process.argv = ['node', argvSnapshot[1] ?? 'cli.ts', ...argv];

  let config: Config;
  try {
    config = await setupConfig();
  } finally {
    process.argv = argvSnapshot;
  }

  // _daemonBrowser tells run() to reuse the persistent browser; _daemonMode tells
  // it to throw DaemonRunError instead of calling process.exit at the end;
  // _daemonEsbuildCache hands buildTestBundle the persistent incremental-context
  // slot so the warm module graph survives across runs. watch/open are forced off
  // — those modes don't make sense inside a daemon run.
  config._daemonMode = true;
  config._daemonBrowser = state.browser;
  config._daemonEsbuildCache = state.esbuildCache;
  config.watch = false;
  config.open = false;

  try {
    await run(config);
    // run() throws DaemonRunError on success in daemon mode; reaching here means it
    // returned without exiting — fall back on the counter.
    return config.COUNTER.failCount > 0 ? 1 : 0;
  } catch (err) {
    if (err instanceof DaemonRunError) return err.exitCode;
    throw err;
  } finally {
    // Restore env: drop keys added during the run, restore changed values.
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
  }
}

async function isLiveSocket(socketPath: string): Promise<boolean> {
  const sock = await probeSocket(socketPath, LIVENESS_PROBE_TIMEOUT_MS);
  if (!sock) return false;
  sock.destroy();
  return true;
}

async function readPkgMtime(cwd: string): Promise<number> {
  try {
    return (await stat(path.join(cwd, 'package.json'))).mtimeMs;
  } catch {
    return 0;
  }
}
