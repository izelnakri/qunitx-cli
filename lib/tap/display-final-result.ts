import type { Counter } from '../types.ts';

/**
 * Prints the TAP plan line and test-run summary (total, pass, skip, fail, duration).
 *
 * ```ts
 * import type { Counter } from '../types.ts';
 *
 * // Defined, not invoked: writes the plan and summary comments to stdout.
 * function example(counter: Counter) {
 *   displayFinalResult(counter, 1240);
 *   // "1..8" then "# tests 8", "# pass 7", … "# duration 1240"
 * }
 * ```
 *
 * @returns {void}
 */

export function displayFinalResult(
  { testCount, passCount, skipCount, todoCount, failCount }: Counter,
  timeTaken: number,
): void {
  process.stdout.write('\n');
  process.stdout.write(`1..${testCount}\n`);
  process.stdout.write(`# tests ${testCount}\n`);
  process.stdout.write(`# pass ${passCount}\n`);
  process.stdout.write(`# skip ${skipCount}\n`);
  process.stdout.write(`# todo ${todoCount}\n`);
  process.stdout.write(`# fail ${failCount}\n`);
  process.stdout.write(`# duration ${timeTaken}\n`);
  process.stdout.write('\n');
}
