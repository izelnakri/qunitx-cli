import { processConsole, type Console } from '../console.ts';
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
  { total, passed, skipped, todo, failed }: Counter,
  timeTaken: number,
  output: Console = processConsole,
): void {
  output.log('\n');
  output.log(`1..${total}\n`);
  output.log(`# tests ${total}\n`);
  output.log(`# pass ${passed}\n`);
  output.log(`# skip ${skipped}\n`);
  output.log(`# todo ${todo}\n`);
  output.log(`# fail ${failed}\n`);
  output.log(`# duration ${timeTaken}\n`);
  output.log('\n');
}
