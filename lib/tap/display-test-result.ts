import { dumpYaml } from './dump-yaml.ts';
import { indentString } from '../utils/indent-string.ts';
import type { TestDetails } from '../reporter/types.ts';
import type { FailureInfo } from '../reporter/failure.ts';

// tape TAP output: ['operator', 'stack', 'at', 'expected', 'actual']
// ava TAP output: ['message', 'name', 'at', 'assertion', 'values'] // Assertion #5, message
/**
 * Formats and prints a single QUnit testEnd event as a TAP `ok`/`not ok` line with an
 * optional YAML failure block. A pure formatter: `testNumber` is the TAP sequence number
 * (the caller owns counting) and `failures` are pre-resolved by `failedAssertions`.
 * @returns {void}
 */
export function TAPDisplayTestResult(
  testNumber: number,
  details: TestDetails,
  failures: FailureInfo[] = [],
): void {
  // NOTE: https://github.com/qunitjs/qunit/blob/master/src/html-reporter/diff.js
  const name = details.fullName.join(' | ');

  if (details.status === 'skipped') {
    process.stdout.write(`ok ${testNumber} ${name} # skip\n`);
  } else if (details.status === 'todo') {
    process.stdout.write(`not ok ${testNumber} ${name} # TODO\n`);
  } else if (details.status === 'failed') {
    process.stdout.write(`not ok ${testNumber} ${name} # (${details.runtime.toFixed(0)} ms)\n`);
    failures.forEach((failure) => {
      process.stdout.write('  ---\n');
      process.stdout.write(
        indentString(
          dumpYaml({
            name: `Assertion #${failure.index}`,
            actual: failure.actual,
            expected: failure.expected,
            message: failure.message,
            stack: failure.stack,
            source: failure.source,
            at: failure.at,
          }),
          4,
        ),
      );
      process.stdout.write('  ...\n');
    });
  } else if (details.status === 'passed') {
    process.stdout.write(`ok ${testNumber} ${name} # (${details.runtime.toFixed(0)} ms)\n`);
  }
}

// not ok 10 test exited without ending: deepEqual true works
//   ---
//     operator: fail
//     at: process.<anonymous> (/home/izelnakri/ava-test/node_modules/tape/index.js:85:19)
//     stack: |-
//       Error: test exited without ending: deepEqual true works
//           at Test.assert [as _assert] (/home/izelnakri/ava-test/node_modules/tape/lib/test.js:269:54)
//   ...

export { TAPDisplayTestResult as default };
