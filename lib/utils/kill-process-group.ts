import { spawnSync } from 'node:child_process';
import * as Result from '../result/index.ts';

/**
 * Sends SIGKILL to a process and its entire process group. Requires the target to have
 * been spawned with `detached: true` so that PGID === pid.
 *
 * On Windows, uses `taskkill /F /T` to kill the process and its entire child tree
 * (renderer, GPU, crashpad helpers etc. that survive a plain process.kill() on Windows).
 * Errors are silently suppressed — ESRCH means the process already exited, which is what
 * we were asking for.
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
  if (!isTargetablePid(pid)) return;

  Result.try(() => {
    if (process.platform === 'win32') {
      // /T kills the process tree; /F forces termination of running processes.
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  });
}

/**
 * Whether `pid` is safe to hand to a **negated** `process.kill`.
 *
 * This guard is the whole reason this module is not a one-liner. `process.kill(-pid)` is the
 * POSIX "signal the whole group" form, and two pid values turn it into something catastrophically
 * broader:
 *
 * - `0` negates to `0`, and `kill(0, …)` signals **every process in the caller's own group** —
 *   for a CLI run from a terminal, that is the shell and everything sharing its job.
 * - `1` negates to `-1`, and `kill(-1, …)` signals **every process the user is permitted to
 *   signal**. On a desktop session that is the session: it logs the user out.
 *
 * Neither is hypothetical from a caller's point of view — `pid` arrives from `ChildProcess.pid`
 * (typed `number | undefined`), from `parseInt` over a `/proc` entry, and from a pid parsed out of
 * a file on disk. Any of those can produce a value the caller believed was a real child's. And
 * because the kill itself is deliberately error-swallowing, a wrong pid leaves no trace at all.
 *
 * So the check lives here, at the primitive, rather than being re-derived at each call site:
 * a group kill is only ever attempted for a pid that could actually be a spawned child.
 *
 * ```ts
 * isTargetablePid(4242); // true
 * isTargetablePid(1); // false — negates to kill(-1), every process the user owns
 * isTargetablePid(0); // false — negates to kill(0), the caller's own process group
 * isTargetablePid(Number.NaN); // false
 * ```
 */
export function isTargetablePid(pid: number): boolean {
  // `> 1` rather than `> 0`: pid 1 is init/systemd, which is never a child of ours, and is the
  // one value whose negation means "everything".
  return Number.isInteger(pid) && pid > 1 && pid !== process.pid;
}
