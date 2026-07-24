import { spawn as spawnProcess } from 'node:child_process';
import { killProcessGroup } from '../utils/kill-process-group.ts';
import { cleanupDir } from './cleanup-dir.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Socket } from 'node:net';
import type { ChromeHandle, EarlyChrome } from '../types.ts';
import { ignore } from '../result/failure.ts';

const CDP_URL_REGEX = /DevTools listening on (ws:\/\/[^\s]+)/;

/**
 * Spawns a headless Chrome process with `--remote-debugging-port=0` and resolves once the
 * CDP WebSocket endpoint appears on stderr. Returns null if Chrome is unavailable or fails
 * to start, so callers can fall back to playwright's normal `chromium.launch()`.
 */
export async function spawn(
  chromePath: string | null | undefined,
  args: string[],
  headless = true,
  onSpawn?: (handle: ChromeHandle) => void,
): Promise<EarlyChrome | null> {
  if (!chromePath) return null;

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'qunitx-chrome-'));
  const headlessArgs = headless ? ['--headless=new'] : [];
  const proc = spawnProcess(
    chromePath,
    ['--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, ...headlessArgs, ...args],
    // detached: true puts Chrome in its own process group (PGID = proc.pid).
    // This lets shutdown() kill the entire group (main process + all renderer/GPU/utility
    // children) with process.kill(-proc.pid, 'SIGKILL'), preventing orphaned Chrome
    // subprocesses from accumulating inotify watches across test runs.
    { stdio: ['ignore', 'ignore', 'pipe'], detached: true },
  );
  // Hand the caller a full handle — proc AND shutdown — synchronously, BEFORE the CDP-ready
  // wait below resolves. `shutdown` is a hoisted declaration closing over just `proc` and
  // `userDataDir`, so it is fully callable this early. The caller (chrome-prelaunch.ts) stores
  // it so both its process.on('exit') reaper and shutdownPrelaunch() can act on a Chrome that
  // dies while CDP is still negotiating — the decoupled-launch daemon path, or any early crash.
  onSpawn?.({ proc, shutdown });

  // userDataDir is cleaned exactly once. On a dead-on-arrival Chrome the `close` handler below
  // rm()s it; on a normal run shutdown()'s cleanupDir() does. Both use rm({ force: true }),
  // so if shutdown() is now called in the pre-CDP window as well, the second removal is a no-op.
  let cdpConnected = false;

  proc.on('close', () => {
    if (!cdpConnected)
      rm(userDataDir, { recursive: true, force: true }).catch(
        ignore('chrome user-data-dir removal after a failed CDP connect'),
      );
    resolveWith(null);
  });
  proc.on('error', () => resolveWith(null));

  let resolveWith!: (value: EarlyChrome | null) => void;
  return new Promise((resolve) => {
    resolveWith = resolve;

    let buffer = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(CDP_URL_REGEX);
      if (!match) return;

      cdpConnected = true;
      // Unref so Chrome + its stderr pipe don't keep the Node.js event loop alive
      // after tests finish. Chrome is killed explicitly via shutdown() or the exit handler.
      proc.unref();
      // A piped child stdio stream is a net.Socket at runtime, but ChildProcess types it as the
      // narrower Readable, which declares no unref().
      (proc.stderr as Socket).unref();

      resolve({
        proc,
        cdpEndpoint: match[1],
        shutdown,
      });
    });
  });

  // Kills Chrome and awaits async temp-dir cleanup before the caller calls process.exit().
  // Must be called while the event loop is still alive so rm() can complete without rmSync.
  //
  // No timeout: SIGKILL is a POSIX guarantee — the kernel delivers it unconditionally and
  // the process cannot catch or ignore it, so `close` always fires. JS's single-threaded
  // event loop makes the exitCode check and once('close') registration atomic — no event
  // can fire between them.
  //
  // We skip any intermediate rm() attempt and go straight to cleanupDir, which uses
  // rm() itself as the synchronisation point (retry until success, not until process-table
  // cleanup). A PGID poll loop would stall indefinitely on zombie early Chrome children
  // (same PGID as Chrome main, awaiting init reaping): kill(-pgid, 0) succeeds for zombies
  // even though their FDs are already released, so the loop never exits.
  async function shutdown(): Promise<void> {
    proc.ref(); // re-ref so the close event fires while the event loop is still running
    if (proc.exitCode === null) {
      killProcessGroup(proc.pid!);
      await new Promise<void>((resolve) => proc.once('close', resolve));
    }
    await cleanupDir(userDataDir);
  }
}
