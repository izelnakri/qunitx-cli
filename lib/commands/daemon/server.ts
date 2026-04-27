import net from 'node:net';
import fs from 'node:fs';
import { writeFile, unlink, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { daemonSocketPath, daemonInfoPath } from '../../utils/daemon-socket-path.ts';
import { attachLineParser, probeSocket } from './socket-utils.ts';
import { setupConfig } from '../../setup/config.ts';
import { setupBrowser, launchBrowser } from '../../setup/browser.ts';
import {
  buildTestBundle,
  runTestsInBrowser,
  DaemonRunError,
  flushConsoleHandlers,
} from '../run/tests-in-browser.ts';
import { writeOutputStaticFiles } from '../../setup/write-output-static-files.ts';
import { runUserModule } from '../../utils/run-user-module.ts';
import { closeWithGrace } from '../../utils/close-with-grace.ts';
import { buildCachedContent } from '../run.ts';
import type { Request, ResponseChunk, RunRequest, DaemonInfo } from './protocol.ts';
import type { Browser } from 'playwright-core';
import type { Config, Connections } from '../../types.ts';

// Daemon idle window: 30 minutes after the last run finishes, the daemon shuts itself
// down. Long enough for typical bursts, short enough that a forgotten daemon reclaims
// resources without manual intervention.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
// Liveness probe ceiling: if a stale socket file's owning process is gone, connect()
// returns ECONNREFUSED almost immediately; the timeout only kicks in when the OS is
// momentarily slow.
const LIVENESS_PROBE_TIMEOUT_MS = 500;

interface DaemonState {
  browser: Browser;
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
  if (fs.existsSync(socketPath) && (await isLiveSocket(socketPath))) process.exit(0);
  // Stale socket from a previous crash — must be removed before listen().
  await unlink(socketPath).catch(() => {});

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

  await listen(state.socketServer, socketPath);
  // chmod after listen — listen creates the socket file, default umask can leave it world-readable.
  await chmod(socketPath, 0o600).catch(() => {});

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
  await Promise.all([
    unlink(state.socketPath).catch(() => {}),
    unlink(state.infoPath).catch(() => {}),
    state.browser.close().catch(() => {}),
  ]);
  process.exit(0);
}

function resetIdleTimer(state: DaemonState): void {
  if (state.idleTimer) clearTimeout(state.idleTimer);
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
 */
function makeInterceptor(
  socket: net.Socket,
  type: 'stdout' | 'stderr',
  isAlive: () => boolean,
): typeof process.stdout.write {
  return ((chunk: unknown, ...args: unknown[]): boolean => {
    const str = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
    if (isAlive()) writeChunk(socket, { type, data: str });
    const cb = args[args.length - 1];
    if (typeof cb === 'function') queueMicrotask(cb as () => void);
    return true;
  }) as typeof process.stdout.write;
}

async function handleRun(req: RunRequest, socket: net.Socket, state: DaemonState): Promise<void> {
  if (state.shuttingDown) {
    writeChunk(socket, { type: 'fatal', message: 'daemon shutting down' });
    return void socket.end();
  }
  if (req.cwd !== state.cwd) {
    writeChunk(socket, {
      type: 'fatal',
      message: `cwd mismatch: daemon=${state.cwd} client=${req.cwd}`,
    });
    return void socket.end();
  }
  if (req.nodeVersion !== process.version) {
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

  let clientAlive = true;
  socket.on('close', () => (clientAlive = false));

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = makeInterceptor(socket, 'stdout', () => clientAlive);
  process.stderr.write = makeInterceptor(socket, 'stderr', () => clientAlive);

  let exitCode = 0;
  try {
    exitCode = await runOnce(req.argv, req.env, state);
  } catch (err) {
    process.stderr.write = origStderrWrite;
    origStderrWrite(`# [qunitx daemon] run error: ${(err as Error).stack || err}\n`);
    if (clientAlive)
      writeChunk(socket, { type: 'fatal', message: (err as Error).message || String(err) });
    exitCode = 1;
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  }

  if (clientAlive) {
    writeChunk(socket, { type: 'done', exitCode });
    socket.end();
  }
  resetIdleTimer(state);
}

/**
 * Performs one test run inside the daemon: re-parses argv via setupConfig, builds the
 * test bundle, opens a fresh page in the daemon's persistent browser, runs tests, and
 * closes per-run resources. The browser stays alive for the next run.
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

  // Daemon never runs watch / open / concurrent multi-group flows.
  config._daemonMode = true;
  config.watch = false;
  config.open = false;

  const cachedContent = await buildCachedContent(config, config.htmlPaths);

  let connections: Connections | null = null;
  let exitCode = 0;
  const fileCount = Object.keys(config.fsTree).length;

  try {
    await buildTestBundle(config, cachedContent);
    connections = await setupBrowser(config, cachedContent, state.browser);
    config.webServer = connections.server;
    await writeOutputStaticFiles(config, cachedContent);

    if (config.before) await runUserModule(`${process.cwd()}/${config.before}`, config, 'before');

    // One TAP version 13 header per daemon run; web-server.ts suppresses its
    // per-WS-connection emission when _daemonMode is set.
    process.stdout.write('TAP version 13\n');
    process.stdout.write(
      `# Running ${fileCount} test file${fileCount === 1 ? '' : 's'} (daemon)\n`,
    );

    // runTestsInBrowser handles 0-tests warning, TAPDisplayFinalResult, and the after
    // hook itself in !_groupMode; on the success path it throws DaemonRunError instead
    // of process.exit when _daemonMode is set.
    try {
      await runTestsInBrowser(config, cachedContent, connections);
      // Defensive fallback if runTestsInBrowser ever returns without throwing in daemon mode.
      exitCode = config.COUNTER.failCount > 0 ? 1 : 0;
    } catch (err) {
      if (err instanceof DaemonRunError) exitCode = err.exitCode;
      else throw err;
    }
  } finally {
    await flushConsoleHandlers(config._pendingConsoleHandlers).catch(() => {});
    if (connections) {
      // Per-run cleanup — never close the daemon's persistent browser.
      await closeWithGrace([connections.page?.close(), connections.server?.close()]);
    }
    // Restore env: drop keys added during the run, restore changed values.
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
  }

  return exitCode;
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
