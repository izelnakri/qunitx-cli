import { module, test } from 'qunitx';
import TAPDisplayTestResult, { extractStackAt } from '../../lib/tap/display-test-result.ts';
import '../helpers/custom-asserts.ts';
import { captureStdout } from '../helpers/capture-stdout.ts';

module('TAP | extractStackAt', { concurrency: true }, () => {
  test('Chrome style: extracts clean URL without parens', (assert) => {
    const stack =
      '    at Object.<anonymous> (http://localhost:1234/tests.js:42:15)\n    at test (http://localhost:1234/tests.js:10:3)';
    assert.strictEqual(extractStackAt(stack), 'http://localhost:1234/tests.js:42:15');
  });

  test('Chrome style: strips file:// prefix from local paths', (assert) => {
    const stack = '    at Object.<anonymous> (file:///home/user/project/tests.js:42:15)';
    assert.strictEqual(extractStackAt(stack), '/home/user/project/tests.js:42:15');
  });

  test('Firefox/WebKit style: extracts URL after @', (assert) => {
    const stack =
      'Object.prototype.<anonymous>@http://localhost:1234/tests.js:42:15\n@http://localhost:1234/tests.js:10:3';
    assert.strictEqual(extractStackAt(stack), 'http://localhost:1234/tests.js:42:15');
  });

  test('returns null for null', (assert) => {
    assert.strictEqual(extractStackAt(null), null);
  });

  test('returns null for empty string', (assert) => {
    assert.strictEqual(extractStackAt(''), null);
  });

  test('returns null for plain error message with no location', (assert) => {
    assert.strictEqual(extractStackAt('Error: something went wrong'), null);
  });
});

module('TAP | TAPDisplayTestResult | output', { concurrency: true }, () => {
  test('null message and stack are not printed in YAML block', (assert) => {
    const COUNTER = {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    };
    const output = captureStdout(() => {
      TAPDisplayTestResult(COUNTER, {
        status: 'failed',
        fullName: ['mod', 'test'],
        runtime: 5,
        assertions: [{ passed: false, todo: false, actual: false, expected: true }],
      });
    });
    assert.notIncludes(output, 'message:', 'null message must not appear in output');
    assert.notIncludes(output, 'stack:', 'null stack must not appear in output');
    assert.notIncludes(output, 'at:', 'null at must not appear in output');
    assert.includes(output, 'actual: false', 'actual must still be printed');
    assert.includes(output, 'expected: true', 'expected must still be printed');
  });

  test('falsy primitive actual values are serialized correctly (0, false, null)', (assert) => {
    for (const [actual, expected, expectedStr] of [
      [0, 1, 'actual: 0'],
      [false, true, 'actual: false'],
      [null, true, 'actual: null'],
    ] as const) {
      const COUNTER = {
        testCount: 0,
        failCount: 0,
        skipCount: 0,
        todoCount: 0,
        passCount: 0,
        errorCount: 0,
      };
      const output = captureStdout(() => {
        TAPDisplayTestResult(COUNTER, {
          status: 'failed',
          fullName: ['mod', 'test'],
          runtime: 0,
          assertions: [{ passed: false, todo: false, actual, expected }],
        });
      });
      assert.includes(output, expectedStr, `actual: ${actual} must not be coerced`);
    }
  });

  test('non-null message appears in YAML block', (assert) => {
    const COUNTER = {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    };
    const output = captureStdout(() => {
      TAPDisplayTestResult(COUNTER, {
        status: 'failed',
        fullName: ['mod', 'test'],
        runtime: 5,
        assertions: [
          { passed: false, todo: false, actual: false, expected: true, message: 'custom message' },
        ],
      });
    });
    assert.includes(output, 'message: custom message', 'non-null message must be printed');
  });

  test('Chrome stack: leading whitespace is trimmed so YAML renders "stack: at ..." not "stack:     at ..."', (assert) => {
    const COUNTER = {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    };
    const output = captureStdout(() => {
      TAPDisplayTestResult(COUNTER, {
        status: 'failed',
        fullName: ['mod', 'test'],
        runtime: 5,
        assertions: [
          {
            passed: false,
            todo: false,
            actual: false,
            expected: true,
            stack: '    at Object.<anonymous> (http://localhost:1234/tests.js:42:15)',
          },
        ],
      });
    });
    // The indented YAML line should be "    stack: at Object..." (4-space block indent + "stack: at")
    // NOT "    stack:     at Object..." (extra leading spaces from Chrome's frame format)
    assert.includes(output, 'stack: at Object', 'stack value must not have leading spaces');
    assert.notIncludes(output, 'stack:     at', 'Chrome frame leading spaces must be trimmed');
  });

  test('Chrome stack: at field is a clean URL without surrounding parens', (assert) => {
    const COUNTER = {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    };
    const output = captureStdout(() => {
      TAPDisplayTestResult(COUNTER, {
        status: 'failed',
        fullName: ['mod', 'test'],
        runtime: 5,
        assertions: [
          {
            passed: false,
            todo: false,
            actual: false,
            expected: true,
            stack: '    at Object.<anonymous> (http://localhost:1234/tests.js:42:15)',
          },
        ],
      });
    });
    assert.includes(output, 'at: http://localhost:1234/tests.js:42:15\n', 'at must be a bare URL');
    assert.notIncludes(output, 'at: (', 'at must not start with opening paren');
  });

  test('YAML block is wrapped in --- / ... delimiters', (assert) => {
    const COUNTER = {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    };
    const output = captureStdout(() => {
      TAPDisplayTestResult(COUNTER, {
        status: 'failed',
        fullName: ['mod', 'test'],
        runtime: 5,
        assertions: [{ passed: false, todo: false, actual: false, expected: true }],
      });
    });
    assert.includes(output, '  ---\n', 'YAML block must open with "  ---"');
    assert.includes(output, '  ...\n', 'YAML block must close with "  ..."');
  });

  test('passed assertion emits "ok N module | test # (Nms)" line', (assert) => {
    const COUNTER = {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    };
    const output = captureStdout(() => {
      TAPDisplayTestResult(COUNTER, {
        status: 'passed',
        fullName: ['myModule', 'my test'],
        runtime: 12,
        assertions: [],
      });
    });
    assert.includes(output, 'ok 1 myModule | my test # (12 ms)\n');
  });

  test('skipped assertion emits "ok N ... # skip" line', (assert) => {
    const COUNTER = {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    };
    const output = captureStdout(() => {
      TAPDisplayTestResult(COUNTER, {
        status: 'skipped',
        fullName: ['myModule', 'my test'],
        runtime: 0,
        assertions: [],
      });
    });
    assert.includes(output, 'ok 1 myModule | my test # skip\n');
  });

  test('todo assertion emits "not ok N ... # TODO" line', (assert) => {
    const COUNTER = {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    };
    const output = captureStdout(() => {
      TAPDisplayTestResult(COUNTER, {
        status: 'todo',
        fullName: ['myModule', 'my test'],
        runtime: 0,
        assertions: [],
      });
    });
    assert.includes(output, 'not ok 1 myModule | my test # TODO\n');
  });

  test('multiple failed assertions each produce their own YAML block', (assert) => {
    const COUNTER = {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    };
    const output = captureStdout(() => {
      TAPDisplayTestResult(COUNTER, {
        status: 'failed',
        fullName: ['mod', 'test'],
        runtime: 10,
        assertions: [
          { passed: false, todo: false, actual: 1, expected: 2 },
          { passed: false, todo: false, actual: 'a', expected: 'b' },
        ],
      });
    });
    assert.includes(output, "name: 'Assertion #1'", 'first assertion block must appear');
    assert.includes(output, "name: 'Assertion #2'", 'second assertion block must appear');
    assert.strictEqual((output.match(/  ---\n/g) || []).length, 2, 'two --- delimiters');
    assert.strictEqual((output.match(/  \.\.\.\n/g) || []).length, 2, 'two ... delimiters');
    assert.strictEqual(COUNTER.errorCount, 2, 'errorCount must reflect both failures');
  });

  test('passed assertion within a failed test does not produce a YAML block', (assert) => {
    const COUNTER = {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    };
    const output = captureStdout(() => {
      TAPDisplayTestResult(COUNTER, {
        status: 'failed',
        fullName: ['mod', 'test'],
        runtime: 5,
        assertions: [
          { passed: true, todo: false, actual: true, expected: true },
          { passed: false, todo: false, actual: false, expected: true },
        ],
      });
    });
    assert.includes(output, "name: 'Assertion #2'", 'the failing assertion must appear');
    assert.notIncludes(output, "name: 'Assertion #1'", 'the passing assertion must not appear');
    assert.strictEqual(COUNTER.errorCount, 1, 'only the failing assertion increments errorCount');
  });

  test('todo assertion within a failed test does not produce a YAML block', (assert) => {
    const COUNTER = {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    };
    const output = captureStdout(() => {
      TAPDisplayTestResult(COUNTER, {
        status: 'failed',
        fullName: ['mod', 'test'],
        runtime: 5,
        assertions: [
          { passed: false, todo: true, actual: false, expected: true },
          { passed: false, todo: false, actual: 0, expected: 1 },
        ],
      });
    });
    assert.includes(output, "name: 'Assertion #2'", 'the non-todo failure must appear');
    assert.notIncludes(output, "name: 'Assertion #1'", 'the todo assertion must not appear');
    assert.strictEqual(COUNTER.errorCount, 1, 'todo assertion must not increment errorCount');
  });
});

module('TAP | TAPDisplayTestResult | COUNTER state', { concurrency: true }, () => {
  test('passed status increments testCount and passCount only', (assert) => {
    const COUNTER = {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    };
    captureStdout(() =>
      TAPDisplayTestResult(COUNTER, {
        status: 'passed',
        fullName: ['m', 't'],
        runtime: 1,
        assertions: [],
      }),
    );
    assert.strictEqual(COUNTER.testCount, 1);
    assert.strictEqual(COUNTER.passCount, 1);
    assert.strictEqual(COUNTER.failCount, 0);
    assert.strictEqual(COUNTER.skipCount, 0);
  });

  test('skipped status increments testCount and skipCount only', (assert) => {
    const COUNTER = {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    };
    captureStdout(() =>
      TAPDisplayTestResult(COUNTER, {
        status: 'skipped',
        fullName: ['m', 't'],
        runtime: 0,
        assertions: [],
      }),
    );
    assert.strictEqual(COUNTER.testCount, 1);
    assert.strictEqual(COUNTER.skipCount, 1);
    assert.strictEqual(COUNTER.passCount, 0);
    assert.strictEqual(COUNTER.failCount, 0);
  });

  test('failed status increments testCount and failCount only (errorCount via assertions)', (assert) => {
    const COUNTER = {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    };
    captureStdout(() =>
      TAPDisplayTestResult(COUNTER, {
        status: 'failed',
        fullName: ['m', 't'],
        runtime: 1,
        assertions: [{ passed: false, todo: false, actual: false, expected: true }],
      }),
    );
    assert.strictEqual(COUNTER.testCount, 1);
    assert.strictEqual(COUNTER.failCount, 1);
    assert.strictEqual(COUNTER.passCount, 0);
    assert.strictEqual(COUNTER.skipCount, 0);
    assert.strictEqual(COUNTER.errorCount, 1);
  });

  test('todo status increments testCount and todoCount only', (assert) => {
    const COUNTER = {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    };
    captureStdout(() =>
      TAPDisplayTestResult(COUNTER, {
        status: 'todo',
        fullName: ['m', 't'],
        runtime: 0,
        assertions: [],
      }),
    );
    assert.strictEqual(COUNTER.testCount, 1);
    assert.strictEqual(COUNTER.todoCount, 1);
    assert.strictEqual(COUNTER.failCount, 0);
    assert.strictEqual(COUNTER.skipCount, 0);
    assert.strictEqual(COUNTER.passCount, 0);
  });
});

module('TAP | TAPDisplayTestResult | COUNTER', { concurrency: true }, () => {
  test('COUNTER.errorCount is initialized and incremented as a number', (assert) => {
    const COUNTER = {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    };
    TAPDisplayTestResult(COUNTER, {
      status: 'failed',
      fullName: ['some module', 'some test'],
      runtime: 10,
      assertions: [
        { passed: false, todo: false, actual: null, expected: true, message: 'fail', stack: '' },
        { passed: false, todo: false, actual: 1, expected: 2, message: 'mismatch', stack: '' },
      ],
    });

    assert.strictEqual(typeof COUNTER.errorCount, 'number', 'errorCount must be a number, not NaN');
    assert.strictEqual(COUNTER.errorCount, 2, 'errorCount should count each failed assertion');
  });

  test('COUNTER starts with no errorCount property and TAPDisplayTestResult leaves it as a valid number', (assert) => {
    // Simulates how COUNTER is actually created in run.js / tests-in-browser.js (no errorCount key)
    const COUNTER = { testCount: 0, failCount: 0, skipCount: 0, todoCount: 0, passCount: 0 };
    TAPDisplayTestResult(COUNTER, {
      status: 'failed',
      fullName: ['mod', 'test'],
      runtime: 5,
      assertions: [
        { passed: false, todo: false, actual: false, expected: true, message: 'x', stack: '' },
      ],
    });

    assert.strictEqual(
      isNaN(COUNTER.errorCount),
      false,
      'COUNTER.errorCount must not be NaN after incrementing an uninitialized property',
    );
    assert.strictEqual(COUNTER.errorCount, 1);
  });
});
