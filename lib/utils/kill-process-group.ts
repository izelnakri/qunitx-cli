/**
 * Sends SIGKILL to a process and its entire process group. Requires the target to have
 * been spawned with `detached: true` so that PGID === pid.
 *
 * On Windows, falls back to killing only the process directly; Job Objects handle
 * children. All errors are silently suppressed — ESRCH means the process already exited.
 */
export function killProcessGroup(pid: number): void {
  try {
    if (process.platform === 'win32') {
      process.kill(pid, 'SIGKILL');
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // ESRCH: process already dead.
  }
}
