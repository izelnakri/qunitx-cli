import { spawn } from 'node:child_process';
import { killProcessGroup } from './kill-process-group.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EarlyChrome } from '../types.ts';

const CDP_URL_REGEX = /DevTools listening on (ws:\/\/[^\s]+)/;

/**
 * Spawns a headless Chrome process with `--remote-debugging-port=0` and resolves once the
 * CDP WebSocket endpoint appears on stderr. Returns null if Chrome is unavailable or fails
 * to start, so callers can fall back to playwright's normal `chromium.launch()`.
 */
export async function preLaunchChrome(
  chromePath: string | null | undefined,
  args: string[],
  headless = true,
): Promise<EarlyChrome | null> {
  if (!chromePath) return null;

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'qunitx-chrome-'));
  const headlessArgs = headless ? ['--headless=new'] : [];
  const proc = spawn(
    chromePath,
    ['--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, ...headlessArgs, ...args],
    // detached: true puts Chrome in its own process group (PGID = proc.pid).
    // This lets shutdown() kill the entire group (main process + all renderer/GPU/utility
    // children) with process.kill(-proc.pid, 'SIGKILL'), preventing orphaned Chrome
    // subprocesses from accumulating inotify watches across test runs.
    { stdio: ['ignore', 'ignore', 'pipe'], detached: true },
  );

  // rm() runs exactly once: here when Chrome never connected (shutdown() won't be called),
  // or in shutdown() when it did. Two concurrent rm() calls on the same dir can race, so
  // the cdpConnected flag ensures only one path ever executes it.
  let cdpConnected = false;

  proc.on('close', () => {
    if (!cdpConnected) rm(userDataDir, { recursive: true, force: true }).catch(() => {});
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
      proc.stderr.unref();

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
  async function shutdown(): Promise<void> {
    proc.ref(); // re-ref so the close event fires while the event loop is still running
    const closed = new Promise<void>((resolve) => {
      if (proc.exitCode !== null) {
        resolve();
        return;
      } // already dead
      proc.once('close', resolve);
    });
    if (proc.exitCode === null) killProcessGroup(proc.pid!);
    await closed;
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

export { preLaunchChrome as default };
