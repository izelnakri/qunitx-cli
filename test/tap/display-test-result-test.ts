import { module, test } from 'qunitx';
import TAPDisplayTestResult from '../../lib/tap/display-test-result.ts';
import { failedAssertions } from '../../lib/reporters/failure.ts';
import type { TestDetails } from '../../lib/reporters/types.ts';
import '../helpers/custom-asserts.ts';
import { captureStdout } from '../helpers/capture-stdout.ts';

// TAPDisplayTestResult is a pure formatter: the caller owns the TAP sequence number and
// pre-resolves failures. This mirrors what TapReporter.onTestEnd does, so these tests still
// exercise the real rendering path.
const render = (details: TestDetails, testNumber = 1): string =>
  captureStdout(() => TAPDisplayTestResult(testNumber, details, failedAssertions(details)));

module('TAP | TAPDisplayTestResult | output', { concurrency: true }, () => {
  test('null message and stack are not printed in YAML block', (assert) => {
    const output = render({
      status: 'failed',
      fullName: ['mod', 'test'],
      runtime: 5,
      assertions: [{ passed: false, todo: false, actual: false, expected: true }],
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
      const output = render({
        status: 'failed',
        fullName: ['mod', 'test'],
        runtime: 0,
        assertions: [{ passed: false, todo: false, actual, expected }],
      });
      assert.includes(output, expectedStr, `actual: ${actual} must not be coerced`);
    }
  });

  test('non-null message appears in YAML block', (assert) => {
    const output = render({
      status: 'failed',
      fullName: ['mod', 'test'],
      runtime: 5,
      assertions: [
        { passed: false, todo: false, actual: false, expected: true, message: 'custom message' },
      ],
    });
    assert.includes(output, 'message: custom message', 'non-null message must be printed');
  });

  test('Chrome stack: leading whitespace is trimmed so YAML renders "stack: at ..." not "stack:     at ..."', (assert) => {
    const output = render({
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
    // The indented YAML line should be "    stack: at Object..." (4-space block indent + "stack: at")
    // NOT "    stack:     at Object..." (extra leading spaces from Chrome's frame format)
    assert.includes(output, 'stack: at Object', 'stack value must not have leading spaces');
    assert.notIncludes(output, 'stack:     at', 'Chrome frame leading spaces must be trimmed');
  });

  test('Chrome stack: at field is a clean URL without surrounding parens', (assert) => {
    const output = render({
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
    assert.includes(output, 'at: http://localhost:1234/tests.js:42:15\n', 'at must be a bare URL');
    assert.notIncludes(output, 'at: (', 'at must not start with opening paren');
  });

  test('YAML block is wrapped in --- / ... delimiters', (assert) => {
    const output = render({
      status: 'failed',
      fullName: ['mod', 'test'],
      runtime: 5,
      assertions: [{ passed: false, todo: false, actual: false, expected: true }],
    });
    assert.includes(output, '  ---\n', 'YAML block must open with "  ---"');
    assert.includes(output, '  ...\n', 'YAML block must close with "  ..."');
  });

  test('passed assertion emits "ok N module | test # (Nms)" line', (assert) => {
    const output = render({
      status: 'passed',
      fullName: ['myModule', 'my test'],
      runtime: 12,
      assertions: [],
    });
    assert.includes(output, 'ok 1 myModule | my test # (12 ms)\n');
  });

  test('skipped assertion emits "ok N ... # skip" line', (assert) => {
    const output = render({
      status: 'skipped',
      fullName: ['myModule', 'my test'],
      runtime: 0,
      assertions: [],
    });
    assert.includes(output, 'ok 1 myModule | my test # skip\n');
  });

  test('todo assertion emits "not ok N ... # TODO" line', (assert) => {
    const output = render({
      status: 'todo',
      fullName: ['myModule', 'my test'],
      runtime: 0,
      assertions: [],
    });
    assert.includes(output, 'not ok 1 myModule | my test # TODO\n');
  });

  test('the TAP sequence number comes from the caller', (assert) => {
    const output = render(
      { status: 'passed', fullName: ['m', 't'], runtime: 1, assertions: [] },
      42,
    );
    assert.includes(output, 'ok 42 m | t # (1 ms)\n', 'caller-supplied test number is used');
  });

  test('multiple failed assertions each produce their own YAML block', (assert) => {
    const output = render({
      status: 'failed',
      fullName: ['mod', 'test'],
      runtime: 10,
      assertions: [
        { passed: false, todo: false, actual: 1, expected: 2 },
        { passed: false, todo: false, actual: 'a', expected: 'b' },
      ],
    });
    assert.includes(output, "name: 'Assertion #1'", 'first assertion block must appear');
    assert.includes(output, "name: 'Assertion #2'", 'second assertion block must appear');
    assert.strictEqual((output.match(/ {2}---\n/g) || []).length, 2, 'two --- delimiters');
    assert.strictEqual((output.match(/ {2}\.\.\.\n/g) || []).length, 2, 'two ... delimiters');
  });

  test('passed assertion within a failed test does not produce a YAML block', (assert) => {
    const output = render({
      status: 'failed',
      fullName: ['mod', 'test'],
      runtime: 5,
      assertions: [
        { passed: true, todo: false, actual: true, expected: true },
        { passed: false, todo: false, actual: false, expected: true },
      ],
    });
    assert.includes(output, "name: 'Assertion #2'", 'the failing assertion must appear');
    assert.notIncludes(output, "name: 'Assertion #1'", 'the passing assertion must not appear');
  });

  test('todo assertion within a failed test does not produce a YAML block', (assert) => {
    const output = render({
      status: 'failed',
      fullName: ['mod', 'test'],
      runtime: 5,
      assertions: [
        { passed: false, todo: true, actual: false, expected: true },
        { passed: false, todo: false, actual: 0, expected: 1 },
      ],
    });
    assert.includes(output, "name: 'Assertion #2'", 'the non-todo failure must appear');
    assert.notIncludes(output, "name: 'Assertion #1'", 'the todo assertion must not appear');
  });
});
