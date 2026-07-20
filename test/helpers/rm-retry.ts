import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

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
  for (let attempt = 1; ; attempt++) {
    try {
      return await rm(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!RETRYABLE_CODES.has(code) || attempt >= attempts) throw error;
      await sleep(delayMs * attempt);
    }
  }
}
