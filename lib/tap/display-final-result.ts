import { processOutput, type Output } from '../reporters/output.ts';
import type { Counter } from '../types.ts';

/**
 * Prints the TAP plan line and test-run summary (total, pass, skip, fail, duration).
 *
 * ```ts
 * import * as TAP from './index.ts';
 *
 * import type { Counter } from '../types.ts';
 *
 * // Defined, not invoked: writes the plan and summary comments to the run's output.
 * function example(counter: Counter) {
 *   TAP.displayFinalResult(counter, 1240);
 *   // "1..8" then "# tests 8", "# pass 7", … "# duration 1240"
 * }
 * ```
 *
 * @returns {void}
 */

export function displayFinalResult(
  { testCount, passCount, skipCount, todoCount, failCount }: Counter,
  timeTaken: number,
  output: Output = processOutput,
): void {
  output.write('\n');
  output.write(`1..${testCount}\n`);
  output.write(`# tests ${testCount}\n`);
  output.write(`# pass ${passCount}\n`);
  output.write(`# skip ${skipCount}\n`);
  output.write(`# todo ${todoCount}\n`);
  output.write(`# fail ${failCount}\n`);
  output.write(`# duration ${timeTaken}\n`);
  output.write('\n');
}
