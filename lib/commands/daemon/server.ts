import net from 'node:net';
import fs from 'node:fs';
import { writeFile, unlink, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
// See lib/commands/run.ts: node:timers returns the unref-capable Timer object
// in both Node and Deno; the bare setTimeout global in Deno is the Web variant.
import { setTimeout, clearTimeout } from 'node:timers';
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
  /**
   * Resolved Chrome handle. `null` until the initial in-flight launch settles
   * (see `browserReady`) and again briefly during `recoverBrowser`. Run
   * handlers MUST go through `awaitBrowser(state)` rather than reading this
   * field directly — it's null until the first awaiting caller resolves it.
   * The split lets `runDaemonServer` `listen()` and write the info file
   * immediately, instead of blocking on Chrome launch. Under CI load Chrome
   * launch tail latencies regularly exceed 100 s; gating socket readiness
   * on Chrome would propagate that latency to every `daemon start`/`status`/
   * ping and exhaust client-side spawn timeouts in both the Node and Deno
   * paths (CI runs 26006815757 + 26007923495).
   */
  browser: Browser | null;
  /**
   * Promise of the in-flight Chrome launch. Settles exactly once for the
   * initial launch and is replaced whenever `recoverBrowser` runs. Awaited
   * inside `handleRun` (via `awaitBrowser`) so a run request that arrives
   * before Chrome is up waits the same amount of time it would have waited
   * for the synchronous launch — but `daemon start`/ping/status return as
   * soon as the socket is up. Decoupling Chrome from socket readiness is the
   * fix for the "Daemon did not start within Ns" timeout class on slow CI.
   */
  browserReady: Promise<Browser>;
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
  /**
   * Single-source Page slot for single-group daemon runs. Lives across runs;
   * `setupBrowser` reuses `slot.page` (when connected) instead of `newPage()`.
   * Closed on daemon shutdown; cleared (set to null) when the page disconnects.
   */
  pageSlot: NonNullable<Config['_daemonPageSlot']>;
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
  // Stale-socket cleanup is deferred to listenWithStaleCleanup below. A blanket
  // unlink here would race two concurrent daemon spawns: A could win listen()
  // and create the socket dirent, then B's pre-listen unlink would remove A's
  // live dirent, B's listen would succeed against a freshly created file at the
  // same path, and both processes end up as live listeners with B's file
  // shadowing A. The stale-cleanup helper gates the unlink on an isLiveSocket
  // probe so a live peer is never unlinked.

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

  // Don't await launchBrowser before listen() — see DaemonState.browserReady
  // for the full rationale. Chrome launch tail latency can exceed 100 s under
  // CI contention; making the daemon socket unreachable that long propagates
  // the latency to every client-side spawn timeout. Kick off the launch in
  // parallel; the dispatch handler awaits it lazily inside `awaitBrowser`.
  const browserReady = launchBrowser(baseConfig);
  // Absorb the unhandled-rejection: an early launch failure is also re-
  // surfaced through `awaitBrowser` to the first awaiting client (which
  // sends a 'fatal' chunk + triggers shutdown). Logging to stderr means an
  // operator with `QUNITX_DAEMON_LOG` set sees exactly when Chrome failed;
  // without this `.catch` the rejection would trip the daemon's
  // `unhandledRejection → shutdown` path before any client ever gets the
  // diagnostic, AND the daemon's stdio is `'ignore'` by default so end
  // users would see nothing.
  browserReady.catch((err) => {
    process.stderr.write(
      `# [qunitx daemon] initial browser launch failed: ${(err as Error).message ?? err}\n`,
    );
  });
  const pkgMtime = await readPkgMtime(cwd);

  const state: DaemonState = {
    browser: null,
    browserReady,
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
    pageSlot: { page: null },
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
  await listenWithStaleCleanup(state.socketServer, socketPath);
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

/**
 * listen() at `socketPath`, cleaning up a stale-socket file without the
 * destructive blanket-unlink the old code used. The old pattern
 * (`unlink → listen`) had a race window: a winner daemon could `listen()` and
 * create the socket dirent, then a concurrent peer's pre-listen `unlink`
 * would remove the winner's live dirent, the peer's `listen()` would succeed
 * against a freshly-created file at the same path, and both processes ended
 * up bound — with the peer's file shadowing the winner. If the peer then
 * died for any reason its `shutdownDaemon` would unlink the SHARED file
 * (both processes had `listenSucceeded=true`), taking down the live socket.
 *
 * The fix is to make the unlink CONDITIONAL on the existing file being stale
 * (no listener on it): if the file is a live socket, the unlink is skipped
 * and the listen below fails fast with EADDRINUSE, letting the existing
 * race-resolution path bail to the winner. listen() on the SAME server
 * can't be called twice across a failed first attempt — Node leaves the
 * server in a partial state, observed as "Daemon did not start within Ns"
 * hangs in CI — so we pre-clean before the first listen rather than
 * catching EADDRINUSE.
 */
async function listenWithStaleCleanup(server: net.Server, socketPath: string): Promise<void> {
  if (fs.existsSync(socketPath) && !(await isLiveSocket(socketPath))) {
    await unlink(socketPath).catch(() => {});
  }
  await listen(server, socketPath);
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
  // Bounded await on the in-flight browser launch so we can close it through
  // Playwright's API rather than relying on the chrome-prelaunch.ts exit hook
  // alone. Two reasons this matters specifically post-decoupling: (1) the
  // daemon can shut down before any run request awaits browserReady — without
  // this wait, state.browser stays null and the Promise's Browser handle leaks
  // (Playwright's Browser keeps its own bookkeeping); (2) the rapid-stop+start
  // test exposes exactly this — leaked Chromes from previous cycles compound
  // and starve the next spawn's Chrome launch budget. 3 s is enough for a
  // healthy CI launch (typical 0.5–2 s); if Chrome takes longer than that the
  // exit hook in chrome-prelaunch.ts (which now tracks the proc synchronously
  // at spawn time) SIGKILLs the in-flight Chrome process as the fallback.
  const SHUTDOWN_BROWSER_GRACE_MS = 3_000;
  const browser =
    state.browser ??
    (await Promise.race([
      state.browserReady.then(
        (b) => b,
        () => null,
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SHUTDOWN_BROWSER_GRACE_MS)),
    ]));
  // Only unlink files this process actually owns. A daemon whose listen() failed
  // (concurrent-spawn race: lost to EADDRINUSE) reaches this path via unhandled-
  // Rejection but doesn't own the socket/info — unlinking corrupts the winner.
  await Promise.all([
    state.listenSucceeded ? unlink(state.socketPath).catch(() => {}) : null,
    state.listenSucceeded ? unlink(state.infoPath).catch(() => {}) : null,
    state.pageSlot.page?.close().catch(() => {}),
    // browser may be null if the launch hadn't settled within the grace window
    // (or never started at all); the chrome-prelaunch exit hook handles that.
    browser?.close().catch(() => {}),
    state.esbuildCache._esbuildContext?.dispose().catch(() => {}),
  ]);
  process.exit(0);
}

/**
 * Resolves the daemon's browser handle, awaiting the in-flight launch on the
 * first call and after `recoverBrowser` replaces `browserReady`. Caches the
 * resolved value on `state.browser` so subsequent handlers skip the await.
 * Throws if the launch failed; `handleRun` wraps the throw and sends a
 * 'fatal' chunk to the client + shuts the daemon down (the next client
 * respawns a fresh daemon).
 */
async function awaitBrowser(state: DaemonState): Promise<Browser> {
  if (state.browser) return state.browser;
  state.browser = await state.browserReady;
  return state.browser;
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

  // Two browser-readiness cases handled here:
  //   1. Initial launch in progress — `state.browser` is null until the decoupled
  //      `browserReady` settles (see runDaemonServer comment). The first run
  //      after spawn awaits it here, paying the launch cost once.
  //   2. Browser died while the daemon was idle — without recovery the run
  //      would hang inside Playwright's CDP send waiting for a response from
  //      a dead Chrome until its 30s internal timeout fires.
  try {
    await awaitBrowser(state);
  } catch (err) {
    writeChunk(socket, {
      type: 'fatal',
      message: `browser launch failed: ${(err as Error).message ?? err}`,
    });
    socket.end();
    return void shutdownDaemon(state, 'initial browser launch failed');
  }
  if (!state.browser!.isConnected()) {
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

  // Browser-crash recovery: relaunch the persistent browser if it died this
  // run. state.browser is non-null here — awaitBrowser succeeded above and
  // recoverBrowser (if it ran) reassigned it; the non-null assertion lets us
  // reuse the existing isConnected() check verbatim.
  if (state.browser!.isConnected()) state.consecutiveCrashes = 0;
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
  state.browser?.close().catch(() => {});
  // The persistent page belongs to the dead browser; drop the reference so the
  // next setupBrowser mints a fresh page on the new browser without paying an
  // isConnected() round-trip on a doomed CDP socket.
  state.pageSlot.page = null;
  // Null state.browser and stage the replacement on browserReady, mirroring
  // the initial-launch shape: any concurrent awaitBrowser caller waits on the
  // new promise instead of returning the dead handle. The .catch keeps the
  // unhandled-rejection logged path consistent with the initial launch.
  state.browser = null;
  state.browserReady = launchBrowser(state.baseConfig, true);
  state.browserReady.catch((err) => {
    process.stderr.write(
      `# [qunitx daemon] browser relaunch failed: ${(err as Error).message ?? err}\n`,
    );
  });
  try {
    state.browser = await state.browserReady;
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
  // state.browser is non-null here — runOnce only fires from handleRun after
  // awaitBrowser has resolved (and recoverBrowser, if it ran, reassigned it).
  config._daemonBrowser = state.browser!;
  config._daemonEsbuildCache = state.esbuildCache;
  config._daemonPageSlot = state.pageSlot;
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
