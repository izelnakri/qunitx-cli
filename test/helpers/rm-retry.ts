import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import * as Result from '../../lib/result/index.ts';

/**
 * Windows error codes for "a handle on this path is still open". All three describe the same
 * condition — a child process (fs.watch directory handles, a browser profile, esbuild's service)
 * that has been killed but whose handles the kernel has not reaped yet. Only retrying EBUSY meant
 * the other two aborted the cleanup on the first attempt.
 */
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

/**
 * Removes a directory tree, retrying while Windows still holds handles on it.
 *
 * A retry ladder rather than a fixed sleep: the wait is only paid when the handles genuinely
 * outlive the process, and a run that releases them immediately does not pay it at all.
 * `rm` is injectable so the retry behavior can be tested without a real filesystem.
 */
export async function rmRetry(
  dir: string,
  {
    attempts = 5,
    delayMs = 300,
    rm = (path: string) => fs.rm(path, { recursive: true, force: true }),
    sleep = delay,
  }: {
    attempts?: number;
    delayMs?: number;
    rm?: (path: string) => Promise<void>;
    sleep?: (ms: number) => Promise<unknown>;
  } = {},
): Promise<void> {
  // The flat classification line right after the boundary: box, test, rethrow what was not
  // declared. A non-retryable failure (EACCES, ENOSPC) escapes on the first attempt instead
  // of burning the whole retry ladder against an error that will never clear.
  for (let attempt = 1; ; attempt++) {
    const removed = await Result.try(rm, dir);
    if (removed.ok) return;
    if (!Result.isErrno(removed.error, ...RETRYABLE_CODES)) throw removed.error;
    if (attempt >= attempts) throw removed.error;
    await sleep(delayMs * attempt);
  }
}
