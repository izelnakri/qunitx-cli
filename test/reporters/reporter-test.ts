import { module, test } from 'qunitx';
import { updateCounter } from '../../lib/reporters/types.ts';
import type { Counter } from '../../lib/types.ts';

// updateCounter owns all counter math, split out of the TAP formatter so the numbers are
// identical no matter which (or how many) reporters are attached. The exit code and the TAP
// plan both read counter, so these invariants are load-bearing.
const newCounter = (): Counter => ({
  testCount: 0,
  failCount: 0,
  skipCount: 0,
  todoCount: 0,
  passCount: 0,
  errorCount: 0,
});

module('reporters | updateCounter', { concurrency: true }, () => {
  test('passed status increments testCount and passCount only', (assert) => {
    const counter = newCounter();
    updateCounter(counter, { status: 'passed', fullName: ['m', 't'], runtime: 1, assertions: [] });
    assert.strictEqual(counter.testCount, 1);
    assert.strictEqual(counter.passCount, 1);
    assert.strictEqual(counter.failCount, 0);
    assert.strictEqual(counter.skipCount, 0);
  });

  test('skipped status increments testCount and skipCount only', (assert) => {
    const counter = newCounter();
    updateCounter(counter, { status: 'skipped', fullName: ['m', 't'], runtime: 0, assertions: [] });
    assert.strictEqual(counter.testCount, 1);
    assert.strictEqual(counter.skipCount, 1);
    assert.strictEqual(counter.passCount, 0);
    assert.strictEqual(counter.failCount, 0);
  });

  test('todo status increments testCount and todoCount only', (assert) => {
    const counter = newCounter();
    updateCounter(counter, { status: 'todo', fullName: ['m', 't'], runtime: 0, assertions: [] });
    assert.strictEqual(counter.testCount, 1);
    assert.strictEqual(counter.todoCount, 1);
    assert.strictEqual(counter.failCount, 0);
    assert.strictEqual(counter.skipCount, 0);
    assert.strictEqual(counter.passCount, 0);
  });

  test('failed status increments testCount and failCount; errorCount counts assertions', (assert) => {
    const counter = newCounter();
    updateCounter(counter, {
      status: 'failed',
      fullName: ['m', 't'],
      runtime: 1,
      assertions: [{ passed: false, todo: false, actual: false, expected: true }],
    });
    assert.strictEqual(counter.testCount, 1);
    assert.strictEqual(counter.failCount, 1);
    assert.strictEqual(counter.passCount, 0);
    assert.strictEqual(counter.skipCount, 0);
    assert.strictEqual(counter.errorCount, 1);
  });

  test('errorCount counts each failing assertion, as a number (never NaN)', (assert) => {
    const counter = newCounter();
    updateCounter(counter, {
      status: 'failed',
      fullName: ['some module', 'some test'],
      runtime: 10,
      assertions: [
        { passed: false, todo: false, actual: null, expected: true, message: 'fail', stack: '' },
        { passed: false, todo: false, actual: 1, expected: 2, message: 'mismatch', stack: '' },
      ],
    });
    assert.strictEqual(typeof counter.errorCount, 'number', 'errorCount must be a number, not NaN');
    assert.strictEqual(counter.errorCount, 2, 'errorCount should count each failed assertion');
  });

  test('errorCount survives a counter created without the key (no NaN)', (assert) => {
    // Mirrors how counter is built in run.ts / tests-in-browser.ts on older paths (no errorCount).
    const counter = {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
    } as Counter;
    updateCounter(counter, {
      status: 'failed',
      fullName: ['mod', 'test'],
      runtime: 5,
      assertions: [
        { passed: false, todo: false, actual: false, expected: true, message: 'x', stack: '' },
      ],
    });
    assert.strictEqual(isNaN(counter.errorCount), false, 'errorCount must not be NaN');
    assert.strictEqual(counter.errorCount, 1);
  });

  test('passing and todo assertions inside a failed test do not raise errorCount', (assert) => {
    const counter = newCounter();
    updateCounter(counter, {
      status: 'failed',
      fullName: ['m', 't'],
      runtime: 5,
      assertions: [
        { passed: true, todo: false, actual: true, expected: true },
        { passed: false, todo: true, actual: false, expected: true },
        { passed: false, todo: false, actual: 0, expected: 1 },
      ],
    });
    assert.strictEqual(counter.errorCount, 1, 'only the genuine failure counts');
  });

  test('a failed test with no assertions array still counts the test', (assert) => {
    const counter = newCounter();
    updateCounter(counter, { status: 'failed', fullName: ['m', 't'], runtime: 1 });
    assert.strictEqual(counter.testCount, 1);
    assert.strictEqual(counter.failCount, 1);
    assert.strictEqual(counter.errorCount, 0, 'no assertions to count');
  });
});
