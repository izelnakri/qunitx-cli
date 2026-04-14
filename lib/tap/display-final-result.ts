import type { Counter } from '../types.ts';

/**
 * Prints the TAP plan line and test-run summary (total, pass, skip, fail, duration).
 * @returns {void}
 */

export function TAPDisplayFinalResult(
  { testCount, passCount, skipCount, failCount }: Counter,
  timeTaken: number,
): void {
  process.stdout.write('\n');
  process.stdout.write(`1..${testCount}\n`);
  process.stdout.write(`# tests ${testCount}\n`);
  process.stdout.write(`# pass ${passCount}\n`);
  process.stdout.write(`# skip ${skipCount}\n`);
  process.stdout.write(`# fail ${failCount}\n`);
  process.stdout.write(`# duration ${timeTaken}\n`);
  process.stdout.write('\n');
}

export { TAPDisplayFinalResult as default };
