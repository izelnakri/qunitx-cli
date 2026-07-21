import { spawn } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { blue, magenta } from '../../utils/color.ts';
import * as Paths from './socket-path.ts';
import { parseDaemonIdleTimeout } from './parse-idle-timeout.ts';
import * as Client from './client.ts';
import pkg from '../../../package.json' with { type: 'json' };

// Daemon startup chains: cli.ts import → Config.setup → Browser.launch (chromium
// connect) → listen() → writeFile(info). Observed timings:
//   Node, Linux/macOS: typical 0.8–2 s, worst observed ~5 s.
//   Node, Windows under heavy CI load: typical 4–8 s, worst observed ~12 s.
//   Deno-compiled binary: each cli call cold-loads ~190 MB of embedded VFS and
//     spawns a binary-as-daemon child that does the same. Under concurrent
//     test load (many parallel daemon spawns + Chrome launches), this stack
//     reliably blows past 60 s (CI runs 25837497338 + 25896459457).
// 120 s gives a wide margin over every observed tail. The cost is asymmetric:
// green runs are unaffected (typical 0.8–5 s, doesn't approach the budget);
// a genuine daemon hang takes 120 s to surface vs 60 s before — fine because
// real hangs are rare and CI job budgets (15–25 min) absorb several. Must
// stay under DEFAULT_EXEC_TIMEOUT_MS (180 s in test/helpers/shell.ts) so the
// daemon's "did not start" message reaches the client before the test exec
// fires SIGTERM.
const SPAWN_TIMEOUT_MS = 120_000;

const highlight = (text: string): string => magenta().bold(text);
const color = (text: string): string => blue(text);

const USAGE = `${highlight(`[qunitx v${pkg.version}] Usage:`)} qunitx ${color('daemon <subcommand>')}

${highlight('Subcommands:')}
${color('$ qunitx daemon start')}    # Spawn a persistent daemon for this project (~2× faster repeated runs)
${color('$ qunitx daemon stop')}     # Stop the running daemon
${color('$ qunitx daemon status')}   # Print pid, socket, and uptime

${highlight('Environment:')}
${color('QUNITX_DAEMON=1')}              : auto-spawn the daemon on the first qunitx run; reuse it on every run after (overrides the CI=1 bypass)
${color('QUNITX_NO_DAEMON=1')}           : never use the daemon for this run
${color('QUNITX_DAEMON_IDLE_TIMEOUT')}   : idle window before self-shutdown (default 30m). Bare number = minutes; ${color('ms')} / ${color('s')} / ${color('m')} / ${color('h')} suffixes accepted (${color('1h')}, ${color('45s')}, ${color('500ms')}). Set to ${color('false')} to disable auto-shutdown. Read at daemon spawn; invalid values warn and fall back to the default.
${color('QUNITX_DAEMON_LOG=<path>')}     : redirect the daemon's stdout + stderr to a file (otherwise lost to the detached spawn)

${highlight('Tip:')} set ${color('QUNITX_DAEMON=1')} to auto-spawn the daemon on the first qunitx run; ${color('$ qunitx --help')} for top-level options.
`;

/**
 * Resolves how to respawn this CLI as the detached daemon child.
 *
 * - SEA / `deno compile` binary: `process.execPath` IS the qunitx binary;
 *   reinvoke with `daemon _serve`. `import.meta.url` is undefined in the
 *   CJS SEA bundle, so any path-based resolution at module scope crashes
 *   the entire `daemon` subcommand. The Deno-compiled binary is detected
 *   via `process.execPath` not ending in `deno`/`deno.exe` (compiled
 *   binaries inherit the user's binary name; only `deno run` keeps the
 *   runtime's own name on the path).
 * - `deno run cli.ts`: respawn `deno run -A <scriptPath> daemon _serve` so
 *   the child enters via the same entrypoint the parent did.
 *   `Deno.mainModule` is the authoritative source and avoids relative-path
 *   surprises.
 * - Source / dist bundle (Node ESM): respawn `node ${process.argv[1]}
 *   daemon _serve` so the child enters via the same entrypoint the parent
 *   did (cli.ts in source, bin/qunitx.js when installed via npm).
 */
async function buildDaemonSpawn(): Promise<{ bin: string; args: string[] }> {
  const sea = await import('node:sea').catch(() => null);
  if (sea?.isSea()) return { bin: process.execPath, args: ['daemon', '_serve'] };

  const deno = (globalThis as { Deno?: { mainModule: string } }).Deno;
  if (deno) {
    // Inside a `deno compile`d binary `Deno.mainModule` is also a `file:` URL
    // (a virtual path under `/tmp/deno-compile-<name>/`), so the previous
    // mainModule-prefix check always fell into the `deno run` branch and tried
    // to spawn `<binary> run -A <virtual-path> daemon _serve` — the binary has
    // no `run` subcommand and the spawn silently failed. process.execPath
    // ending in `deno` (or `deno.exe`) is the reliable signal: only `deno run`
    // preserves the runtime's name on the path.
    if (!/[/\\]deno(\.exe)?$/i.test(process.execPath)) {
      return { bin: process.execPath, args: ['daemon', '_serve'] };
    }
    const { fileURLToPath } = await import('node:url');
    return {
      bin: process.execPath,
      args: ['run', '-A', fileURLToPath(deno.mainModule), 'daemon', '_serve'],
    };
  }

  return { bin: process.execPath, args: [process.argv[1], 'daemon', '_serve'] };
}

/**
 * Dispatches `qunitx daemon <subcommand>`. `_serve` runs the in-process daemon loop
 * (spawned by `start`); all other subcommands are client operations. No subcommand
 * (or `--help` / `-h` / `help`) prints usage and exits 0; an unknown subcommand
 * prints usage to stderr and exits 1.
 */
export function runCommand(): Promise<number> {
  const sub = process.argv[3];
  if (sub === '_serve') return runServeMode();
  if (sub === 'start') return startDaemon();
  if (sub === 'stop') return stopDaemon();
  if (sub === 'status') return statusDaemon();
  const helpRequested = !sub || sub === '--help' || sub === '-h' || sub === 'help';
  const out = helpRequested ? process.stdout : process.stderr;
  out.write(USAGE);
  return Promise.resolve(helpRequested ? 0 : 1);
}

async function runServeMode(): Promise<number> {
  const Server = await import('./server.ts');
  await Server.serve();
  // Unreachable: Server.serve enters an event loop that exits via Client.shutdown.
  return 0;
}

// Polling interval for waitForFile.
//
// POSIX (2 s): event-driven via fs.watch is the fast path; polling is a
// safety net for kernel notification drops (inotify queue overflow on Linux,
// FSEvents coalescing on macOS under load). 2 s is short enough that
// worst-case latency stays well under SPAWN_TIMEOUT_MS (120 s) and long
// enough that polling cost is negligible (60 stats over the full budget).
//
// Windows (100 ms): polling IS the fast path — fs.watch is disabled (see
// waitForFile). Tighter interval keeps latency snappy. 100 ms × 1200 polls
// = SPAWN_TIMEOUT_MS = 120 s, 6 µs per stat ≈ <8 ms of total CPU.
const WAIT_FOR_FILE_POLL_MS = process.platform === 'win32' ? 100 : 2_000;

/**
 * Bounded wait for `filePath` to appear, returning `true` on success or `false`
 * after `timeoutMs`.
 *
 * POSIX: subscribes to fs.watch on the parent directory for sub-ms detection
 * (kernel notify path), with a polling fallback to catch dropped events.
 *
 * Windows: polls only — fs.watch on Windows occasionally crashes the process
 * with
 *   Assertion failed: !_wcsnicmp(filename, dir, dirlen),
 *     file src\win\fs-event.c, line 72
 * (libuv exit 3221226505 / STATUS_STACK_BUFFER_OVERRUN) when path normalisation
 * inside libuv produces a prefix mismatch between the watched directory and the
 * event's absolute path. Even watching a small private subdir doesn't reliably
 * dodge it under parallel CI load (reproduced on test (windows-latest) and
 * test-deno (windows-latest) in CI runs 26552908498 / 26694937698). The
 * 100 ms poll gives near-event-driven latency without the crash; daemon
 * startup takes 0.8-12 s on Windows so the extra 50 ms average detection
 * latency is irrelevant.
 *
 * Two `existsSync` calls bracket subscription to close the TOCTOU gap: the
 * file may appear between the entry-point check and the watcher/interval
 * actually being live. Multiple `settle` calls are harmless: `resolve`,
 * `clearTimeout`, `clearInterval`, and `fsWatcher.close` are all idempotent.
 */
function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  if (existsSync(filePath)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const dir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    let watcher: fs.FSWatcher | null = null;
    const settle = (ok: boolean) => {
      clearTimeout(timer);
      clearInterval(poll);
      watcher?.close();
      resolve(ok);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    const poll = setInterval(() => {
      if (existsSync(filePath)) settle(true);
    }, WAIT_FOR_FILE_POLL_MS);
    if (process.platform !== 'win32') {
      watcher = fs.watch(dir, (_event, name) => {
        // Reconfirm with existsSync — fs.watch fires for both create and unlink.
        if (name === fileName && existsSync(filePath)) settle(true);
      });
      watcher.on('error', () => settle(false));
    }
    // Re-check now that the watch/poll is live (TOCTOU close).
    if (existsSync(filePath)) settle(true);
  });
}

/**
 * Spawns a detached daemon process and waits for it to be *fully* ready.
 *
 * Two signals must both be true before we return success:
 *
 * 1. The info file exists at `Paths.info()`. The daemon writes this *after*
 *    `listen()` resolves, so its presence is the first observable signal that
 *    startup is complete. We wait for it via `fs.watch` — event-driven, no polling.
 * 2. `Client.ping()` returns a `pong`. Confirms the daemon is actually accepting
 *    connections (rules out a stale info file from a crashed previous daemon).
 *
 * Either signal alone is insufficient: pong-only races the post-listen writeFile
 * (sub-ms on Linux, tens of ms on Windows NTFS); file-only would falsely accept
 * stale presence sentinels. Both must hold.
 */
async function spawnAndWaitForDaemon(): Promise<{ pid: number } | null> {
  // Validate QUNITX_DAEMON_IDLE_TIMEOUT here — the daemon detaches with stdio:'ignore'
  // so a warning printed from inside it is invisible. Doing it on the CLI side puts
  // the message on the user's terminal at the moment the env value first becomes
  // load-bearing (i.e. a fresh spawn).
  const parsed = parseDaemonIdleTimeout(process.env.QUNITX_DAEMON_IDLE_TIMEOUT);
  if (parsed.warning) process.stderr.write(parsed.warning + '\n');

  // Create the per-cwd daemon dir on the client side BEFORE waitForFile attaches
  // fs.watch to it. The daemon process also mkdir's it (idempotent), but that
  // happens after spawn → race window where fs.watch fires ENOENT. Doing it
  // here closes the race; recursive:true is safe across concurrent attempts.
  await mkdir(Paths.dir(), { recursive: true });

  // Detached so the daemon outlives the current shell. stdio: 'ignore' detaches all
  // pipes; daemon writes its own startup line to its stderr (now /dev/null analogue).
  const { bin, args } = await buildDaemonSpawn();
  spawn(bin, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, QUNITX_DAEMON_CWD: process.cwd() },
  }).unref();

  if (!(await waitForFile(Paths.info(), SPAWN_TIMEOUT_MS))) return null;
  const pong = await Client.ping();
  return pong?.type === 'pong' ? { pid: pong.pid } : null;
}

/**
 * Ensures a daemon is reachable for the current cwd. Returns true if one was
 * already running or was successfully spawned; false on spawn timeout. Silent —
 * intended for the cli.ts auto-spawn path where the spawn is incidental to the run.
 */
export async function ensureRunning(): Promise<boolean> {
  if ((await Client.ping())?.type === 'pong') return true;
  return Boolean(await spawnAndWaitForDaemon());
}

async function startDaemon(): Promise<number> {
  const existing = await Client.ping();
  if (existing?.type === 'pong') {
    process.stdout.write(`Daemon already running (pid ${existing.pid})\n`);
    return 0;
  }
  const result = await spawnAndWaitForDaemon();
  if (result) {
    process.stdout.write(`Daemon started (pid ${result.pid})\n`);
    return 0;
  }
  process.stderr.write(`Daemon did not start within ${SPAWN_TIMEOUT_MS / 1000}s\n`);
  return 1;
}

async function stopDaemon(): Promise<number> {
  const stopped = await Client.shutdown();
  process.stdout.write(stopped ? 'Daemon stopped\n' : 'No daemon was running\n');
  return 0;
}

async function statusDaemon(): Promise<number> {
  const pong = await Client.ping();
  if (pong?.type !== 'pong') {
    process.stdout.write('No daemon running for this project\n');
    return 1;
  }
  const ageMin = Math.round((Date.now() - pong.startedAt) / 60_000);
  process.stdout.write(
    `Daemon running\n` +
      `  pid:     ${pong.pid}\n` +
      `  cwd:     ${pong.cwd}\n` +
      `  node:    ${pong.nodeVersion}\n` +
      `  uptime:  ${ageMin} min\n` +
      `  socket:  ${Paths.socket(pong.cwd)}\n`,
  );
  return 0;
}
