import { dumpYaml } from './dump-yaml.ts';
import { indentString } from '../utils/indent-string.ts';
import type { Counter } from '../types.ts';

interface TestAssertion {
  passed: boolean;
  todo: boolean;
  stack?: string;
  actual?: unknown;
  expected?: unknown;
  message?: string;
}
interface TestDetails {
  status: string;
  fullName: string[];
  runtime: number;
  assertions: TestAssertion[];
}

// tape TAP output: ['operator', 'stack', 'at', 'expected', 'actual']
// ava TAP output: ['message', 'name', 'at', 'assertion', 'values'] // Assertion #5, message
/**
 * Formats and prints a single QUnit testEnd event as a TAP `ok`/`not ok` line with optional YAML failure block.
 * @returns {void}
 */
export function TAPDisplayTestResult(COUNTER: Counter, details: TestDetails): void {
  // NOTE: https://github.com/qunitjs/qunit/blob/master/src/html-reporter/diff.js
  COUNTER.testCount++;

  if (details.status === 'skipped') {
    COUNTER.skipCount++;
    console.log(`ok ${COUNTER.testCount}`, details.fullName.join(' | '), '# skip');
  } else if (details.status === 'todo') {
    console.log(`not ok ${COUNTER.testCount}`, details.fullName.join(' | '), '# skip');
  } else if (details.status === 'failed') {
    COUNTER.failCount++;
    console.log(
      `not ok ${COUNTER.testCount}`,
      details.fullName.join(' | '),
      `# (${details.runtime.toFixed(0)} ms)`,
    );
    details.assertions.forEach((assertion, index) => {
      if (!assertion.passed && assertion.todo === false) {
        COUNTER.errorCount = (COUNTER.errorCount ?? 0) + 1;
        const stack = assertion.stack?.match(/\(.+\)/g);

        console.log('  ---');
        console.log(
          indentString(
            dumpYaml({
              name: `Assertion #${index + 1}`,
              actual: assertion.actual
                ? JSON.parse(JSON.stringify(assertion.actual, getCircularReplacer()))
                : assertion.actual,
              expected: assertion.expected
                ? JSON.parse(JSON.stringify(assertion.expected, getCircularReplacer()))
                : assertion.expected,
              message: assertion.message || null,
              stack: assertion.stack || null,
              at: stack ? stack[0].replace('(file://', '').replace(')', '') : null,
            }),
            4,
          ),
        );
        console.log('  ...');
      }
    });
  } else if (details.status === 'passed') {
    COUNTER.passCount++;
    console.log(
      `ok ${COUNTER.testCount}`,
      details.fullName.join(' | '),
      `# (${details.runtime.toFixed(0)} ms)`,
    );
  }
}

function getCircularReplacer(): (_key: string, value: unknown) => unknown {
  const ancestors: object[] = [];
  return function (this: object, _key: string, value: unknown) {
    if (typeof value !== 'object' || value === null) {
      return value;
    }
    while (ancestors.length > 0 && ancestors.at(-1) !== this) {
      ancestors.pop();
    }
    if (ancestors.includes(value)) {
      return '[Circular]';
    }
    ancestors.push(value);
    return value;
  };
}

// not ok 10 test exited without ending: deepEqual true works
//   ---
//     operator: fail
//     at: process.<anonymous> (/home/izelnakri/ava-test/node_modules/tape/index.js:85:19)
//     stack: |-
//       Error: test exited without ending: deepEqual true works
//           at Test.assert [as _assert] (/home/izelnakri/ava-test/node_modules/tape/lib/test.js:269:54)
//           at Test.bound [as _assert] (/home/izelnakri/ava-test/node_modules/tape/lib/test.js:90:32)
//           at Test.fail (/home/izelnakri/ava-test/node_modules/tape/lib/test.js:363:10)
//           at Test.bound [as fail] (/home/izelnakri/ava-test/node_modules/tape/lib/test.js:90:32)
//           at Test._exit (/home/izelnakri/ava-test/node_modules/tape/lib/test.js:226:14)
//           at Test.bound [as _exit] (/home/izelnakri/ava-test/node_modules/tape/lib/test.js:90:32)
//           at process.<anonymous> (/home/izelnakri/ava-test/node_modules/tape/index.js:85:19)
//           at process.emit (node:events:376:20)
//   ...

export { TAPDisplayTestResult as default };
