import { module, test } from 'qunitx';
import { updateCounter } from '../../lib/reporters/types.ts';
import type { Counter } from '../../lib/types.ts';

// updateCounter owns all counter math, split out of the TAP formatter so the numbers are
// identical no matter which (or how many) reporters are attached. The exit code and the TAP
// plan both read counter, so these invariants are load-bearing.
const newCounter = (): Counter => ({
  total: 0,
  failed: 0,
  skipped: 0,
  todo: 0,
  passed: 0,
  assertionsFailed: 0,
});

module('Reporters | updateCounter', { concurrency: true }, () => {
  test('passed status increments total and passed only', (assert) => {
    const counter = newCounter();
    updateCounter(counter, { status: 'passed', fullName: ['m', 't'], runtime: 1, assertions: [] });
    assert.strictEqual(counter.total, 1);
    assert.strictEqual(counter.passed, 1);
    assert.strictEqual(counter.failed, 0);
    assert.strictEqual(counter.skipped, 0);
  });

  test('skipped status increments total and skipped only', (assert) => {
    const counter = newCounter();
    updateCounter(counter, { status: 'skipped', fullName: ['m', 't'], runtime: 0, assertions: [] });
    assert.strictEqual(counter.total, 1);
    assert.strictEqual(counter.skipped, 1);
    assert.strictEqual(counter.passed, 0);
    assert.strictEqual(counter.failed, 0);
  });

  test('todo status increments total and todo only', (assert) => {
    const counter = newCounter();
    updateCounter(counter, { status: 'todo', fullName: ['m', 't'], runtime: 0, assertions: [] });
    assert.strictEqual(counter.total, 1);
    assert.strictEqual(counter.todo, 1);
    assert.strictEqual(counter.failed, 0);
    assert.strictEqual(counter.skipped, 0);
    assert.strictEqual(counter.passed, 0);
  });

  test('failed status increments total and failed; assertionsFailed counts assertions', (assert) => {
    const counter = newCounter();
    updateCounter(counter, {
      status: 'failed',
      fullName: ['m', 't'],
      runtime: 1,
      assertions: [{ passed: false, todo: false, actual: false, expected: true }],
    });
    assert.strictEqual(counter.total, 1);
    assert.strictEqual(counter.failed, 1);
    assert.strictEqual(counter.passed, 0);
    assert.strictEqual(counter.skipped, 0);
    assert.strictEqual(counter.assertionsFailed, 1);
  });

  test('assertionsFailed counts each failing assertion, as a number (never NaN)', (assert) => {
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
    assert.strictEqual(
      typeof counter.assertionsFailed,
      'number',
      'assertionsFailed must be a number, not NaN',
    );
    assert.strictEqual(
      counter.assertionsFailed,
      2,
      'assertionsFailed should count each failed assertion',
    );
  });

  test('assertionsFailed survives a counter created without the key (no NaN)', (assert) => {
    // Mirrors how counter is built in run.ts / tests-in-browser.ts on older paths (no assertionsFailed).
    const counter = {
      total: 0,
      failed: 0,
      skipped: 0,
      todo: 0,
      passed: 0,
    } as Counter;
    updateCounter(counter, {
      status: 'failed',
      fullName: ['mod', 'test'],
      runtime: 5,
      assertions: [
        { passed: false, todo: false, actual: false, expected: true, message: 'x', stack: '' },
      ],
    });
    assert.strictEqual(isNaN(counter.assertionsFailed), false, 'assertionsFailed must not be NaN');
    assert.strictEqual(counter.assertionsFailed, 1);
  });

  test('passing and todo assertions inside a failed test do not raise assertionsFailed', (assert) => {
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
    assert.strictEqual(counter.assertionsFailed, 1, 'only the genuine failure counts');
  });

  test('a failed test with no assertions array still counts the test', (assert) => {
    const counter = newCounter();
    updateCounter(counter, { status: 'failed', fullName: ['m', 't'], runtime: 1 });
    assert.strictEqual(counter.total, 1);
    assert.strictEqual(counter.failed, 1);
    assert.strictEqual(counter.assertionsFailed, 0, 'no assertions to count');
  });
});
