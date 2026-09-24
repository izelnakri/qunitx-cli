// node:timers returns a Timer object in both Node and Deno; Deno's bare `setInterval` global is
// the Web platform variant, which returns a number and has no unref/ref.
import { setInterval, clearInterval } from 'node:timers';

// One no-op callback every 10s costs nothing to run and cannot be mistaken for work. The period
// never matters — only that a ref'd handle exists for as long as the work does.
const KEEP_ALIVE_INTERVAL_MS = 10_000;

/**
 * Runs `work` with the event loop held open, so it cannot end by everything going quiet.
 *
 * A run's handles are deliberately not enough to keep Node alive: the pre-launched Chrome and its
 * stderr pipe are `unref`'d (see chrome/spawn.ts), page and server closes are bounded by unref'd
 * timers, and Playwright drops its transport the moment a browser dies. So a browser that dies at
 * the wrong moment leaves a process with nothing left to do, and a process with nothing left to do
 * exits — reporting code 0, having printed nothing but its header. That is not a theory: Windows CI
 * run 35946105100 announced `# Running 1 test file across 1 group`, went silent for 21s, and exited
 * 0, with an assertion in line-target-test.ts as the only sign that a run had been lost.
 *
 * Held open, the same failure has to end as a failure — a timeout, a rejection, something said out
 * loud — because nothing else can end the process while this is armed. The `finally` is what makes
 * that safe to wrap around anything: an interval nobody clears is the opposite bug.
 *
 * ```ts
 * import { withLoopAlive } from './with-loop-alive.ts';
 *
 * await withLoopAlive(() => Promise.resolve('finished')); // 'finished'
 * ```
 */
export async function withLoopAlive<T>(work: () => Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, KEEP_ALIVE_INTERVAL_MS);
  try {
    return await work();
  } finally {
    clearInterval(keepAlive);
  }
}
