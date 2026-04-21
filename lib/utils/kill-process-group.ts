import { spawnSync } from 'node:child_process';

/**
 * Sends SIGKILL to a process and its entire process group. Requires the target to have
 * been spawned with `detached: true` so that PGID === pid.
 *
 * On Windows, uses `taskkill /F /T` to kill the process and its entire child tree
 * (renderer, GPU, crashpad helpers etc. that survive a plain process.kill() on Windows).
 * All errors are silently suppressed — ESRCH means the process already exited.
 */
export function killProcessGroup(pid: number): void {
  try {
    if (process.platform === 'win32') {
      // /T kills the process tree; /F forces termination of running processes.
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // ESRCH: process already dead.
  }
}
