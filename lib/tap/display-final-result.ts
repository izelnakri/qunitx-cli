import type { Counter } from '../types.ts';

/**
 * Prints the TAP plan line and test-run summary (total, pass, skip, fail, duration).
 * @returns {void}
 */

export function TAPDisplayFinalResult(
  { testCount, passCount, skipCount, failCount }: Counter,
  timeTaken: number,
): void {
  console.log('');
  console.log(`1..${testCount}`);
  console.log(`# tests ${testCount}`);
  console.log(`# pass ${passCount}`);
  console.log(`# skip ${skipCount}`);
  console.log(`# fail ${failCount}`);

  // let seconds = timeTaken > 1000 ? Math.floor(timeTaken / 1000) : 0;
  // let milliseconds = timeTaken % 100;

  console.log(`# duration ${timeTaken}`);
  console.log('');
}
// console.log(details.timeTaken); // runtime

export { TAPDisplayFinalResult as default };
