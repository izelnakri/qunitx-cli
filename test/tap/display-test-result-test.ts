import { module, test } from 'qunitx';
import TAPDisplayTestResult from '../../lib/tap/display-test-result.ts';

module('TAP | TAPDisplayTestResult | COUNTER', () => {
  test('COUNTER.errorCount is initialized and incremented as a number', (assert) => {
    const COUNTER = { testCount: 0, failCount: 0, skipCount: 0, passCount: 0, errorCount: 0 };
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
    const COUNTER = { testCount: 0, failCount: 0, skipCount: 0, passCount: 0 };
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
