import * as Result from '../result/index.ts';

/**
 * Prints what went wrong, and only then reaps the pre-launched Chrome.
 *
 * The order is the whole point, and it is the same rule the config-failure path in `cli.ts`
 * already follows: `shutdownPrelaunch()` waits on a Chrome that may still be starting, and on
 * Windows the event loop can drain inside that wait — Node then exits on its own, before any
 * message queued after the await has been written. `qunitx repl missing-file.ts` exited 1 with
 * an EMPTY stderr on the Windows runner for exactly that reason, while the same command on Linux
 * (and the same command with `--browser=webkit`, which never pre-launches anything) reported
 * itself correctly.
 *
 * Two tiers, unchanged from what the crash boundary has always done: a declared failure is a
 * message, a bug keeps its stack.
 *
 * ```ts
 * import { reportCrash } from './report-crash.ts';
 *
 * const printed: unknown[] = [];
 * // A shutdown that never settles is what the Windows runner looked like from here. Not awaited,
 * // for that reason — the point is that the message is already out by now.
 * void reportCrash(new Error('boom'), () => new Promise(() => {}), (line) => printed.push(line));
 * printed.length; // 1 — printed BEFORE the reap, never after it
 * ```
 */
export async function reportCrash(
  error: unknown,
  shutdown: () => Promise<void>,
  print: (message: unknown) => void = console.error,
): Promise<void> {
  print(Result.Failure.is(error) ? Result.Failure.format(error) : error);
  await shutdown();
}
