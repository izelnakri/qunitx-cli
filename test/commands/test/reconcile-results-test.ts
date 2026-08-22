import { module, test } from 'qunitx';
import { reconcileUndeliveredResults } from '../../../lib/commands/test/tests-in-browser.ts';
import type { Counter, QUnitResult } from '../../../lib/types.ts';

// Regression coverage for the silent exit-0 flake on windows-latest (CI run 29776544275): a
// single-file run of a 4-test file reported "0 tests" and exited 0. The WebSocket testEnd stream
// is the only channel feeding the counter, and under CPU starvation some events never arrive —
// the run then looked empty even though QUnit finished every test in the page. QUnit's own tally
// is authoritative, so the runner reconciles from it instead of reporting an empty, passing run.

const counter = (over: Partial<Counter> = {}): Counter => ({
  total: 0,
  failed: 0,
  skipped: 0,
  todo: 0,
  passed: 0,
  assertionsFailed: 0,
  ...over,
});

const qunit = (over: Partial<QUnitResult> = {}): QUnitResult => ({
  totalTests: 4,
  finishedTests: 4,
  failedTests: 0,
  currentTest: null,
  ...over,
});

module('Commands | run | reconcileUndeliveredResults', { concurrency: true }, () => {
  test('all four testEnds lost: reports the passing run, not an empty one', (assert) => {
    const c = counter(); // nothing delivered
    const undelivered = reconcileUndeliveredResults(c, qunit({ finishedTests: 4, failedTests: 0 }));

    assert.equal(undelivered, 4, 'four results were missing from the stream');
    assert.equal(c.total, 4, 'total reconciled from QUnit');
    assert.equal(c.passed, 4, 'all four counted as passing');
    assert.equal(c.failed, 0, 'exit code stays 0');
  });

  test('a lost failure is never masked as a pass', (assert) => {
    const c = counter();
    const undelivered = reconcileUndeliveredResults(c, qunit({ finishedTests: 4, failedTests: 1 }));

    assert.equal(undelivered, 4);
    assert.equal(c.total, 4);
    assert.equal(c.failed, 1, 'the dropped failure still counts — exit code becomes non-zero');
    assert.equal(c.passed, 3, 'the other three counted as passing');
  });

  test('partial delivery: only the missing tail is reconciled', (assert) => {
    const c = counter({ total: 2, passed: 2 }); // two arrived, two lost
    const undelivered = reconcileUndeliveredResults(c, qunit({ finishedTests: 4, failedTests: 0 }));

    assert.equal(undelivered, 2, 'two results were missing');
    assert.equal(c.total, 4);
    assert.equal(c.passed, 4);
  });

  test('clean run: everything delivered, nothing touched', (assert) => {
    const c = counter({ total: 4, passed: 4 });
    const undelivered = reconcileUndeliveredResults(c, qunit({ finishedTests: 4, failedTests: 0 }));

    assert.equal(undelivered, 0, 'no reconciliation needed');
    assert.equal(c.total, 4);
    assert.equal(c.passed, 4);
  });

  test('all delivered but a failure was undercounted: failed still corrected', (assert) => {
    // finishedTests === total, so no total gap — but the browser saw a failure the stream
    // dropped. This is the pre-existing safety net, preserved: bump failed, return 0.
    const c = counter({ total: 4, passed: 4, failed: 0 });
    const undelivered = reconcileUndeliveredResults(c, qunit({ finishedTests: 4, failedTests: 1 }));

    assert.equal(undelivered, 0, 'nothing was missing from the total');
    assert.equal(c.failed, 1, 'the dropped failure is still counted');
    assert.equal(c.passed, 3, 'and a pass is corrected back to a fail');
  });

  test('does not invent tests when the browser finished fewer than counted', (assert) => {
    // Defensive: a stale/lower QUnit tally must never shrink an accurate counter.
    const c = counter({ total: 4, passed: 4 });
    const undelivered = reconcileUndeliveredResults(c, qunit({ finishedTests: 2, failedTests: 0 }));

    assert.equal(undelivered, 0);
    assert.equal(c.total, 4, 'the accurate count is left alone');
  });
});
