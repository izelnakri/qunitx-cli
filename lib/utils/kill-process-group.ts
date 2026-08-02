import { spawnSync } from 'node:child_process';
import * as Result from '../result/index.ts';

/**
 * Sends SIGKILL to a process and its entire process group. Requires the target to have
 * been spawned with `detached: true` so that PGID === pid.
 *
 * On Windows, uses `taskkill /F /T` to kill the process and its entire child tree
 * (renderer, GPU, crashpad helpers etc. that survive a plain process.kill() on Windows).
 * All errors are silently suppressed — ESRCH means the process already exited.
 *
 * ```ts
 * import type { ChildProcess } from 'node:child_process';
 *
 * // Defined, not invoked: SIGKILLs a live process group.
 * function reapChrome(chrome: ChildProcess) {
 *   if (chrome.pid) killProcessGroup(chrome.pid); // takes renderer/GPU helpers down with it
 * }
 * ```
 */
export function killProcessGroup(pid: number): void {
  // ESRCH: the process is already dead, which is what we were asking for.
  Result.try(() => {
    if (process.platform === 'win32') {
      // /T kills the process tree; /F forces termination of running processes.
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  });
}
