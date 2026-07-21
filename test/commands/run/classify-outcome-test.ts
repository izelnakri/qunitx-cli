import { module, test } from 'qunitx';
import { classifyRunOutcome } from '../../../lib/commands/run/tests-in-browser.ts';
import type { QUnitResult } from '../../../lib/types.ts';

// Regression coverage for the silent exit-0 flake on v0.31.0 windows-latest (--coverage). The
// injected runtime pre-initialises window.QUNIT_RESULT to a zero tally at page load, so a run
// that timed out before tests.js executed reads `totalTests === 0` — identical to a genuinely
// empty file. Treating them the same let a CPU-starved timeout pass silently as green. QUnit
// fires `done` even for an empty file, so the presence of a `done` is what separates them.

const result = (over: Partial<QUnitResult> = {}): QUnitResult => ({
  totalTests: 4,
  finishedTests: 4,
  failedTests: 0,
  currentTest: null,
  ...over,
});

module('Commands | run | classifyRunOutcome', { concurrency: true }, () => {
  test('zero tests WITH a done is a genuinely empty file (benign)', (assert) => {
    assert.deepEqual(classifyRunOutcome(result({ totalTests: 0, finishedTests: 0 }), true), {
      kind: 'empty',
    });
  });

  test('zero tests WITHOUT a done is a timeout, not empty — the flake', (assert) => {
    // The runtime pre-initialised the tally; the race timer fired before tests.js ran.
    assert.deepEqual(classifyRunOutcome(result({ totalTests: 0, finishedTests: 0 }), false), {
      kind: 'no-tests-ran',
    });
  });

  test('no result object at all is a timeout regardless of the done flag', (assert) => {
    assert.deepEqual(classifyRunOutcome(undefined, false), { kind: 'no-tests-ran' });
    assert.deepEqual(classifyRunOutcome(null, true), { kind: 'no-tests-ran' });
  });

  test('all registered tests finished is a completed run', (assert) => {
    assert.deepEqual(classifyRunOutcome(result({ totalTests: 4, finishedTests: 4 }), true), {
      kind: 'completed',
    });
  });

  test('a completed run is reported even when done was lost (transport, not execution)', (assert) => {
    // finished === total means the tests ran; a missing done is a delivery problem the caller
    // reconciles, not a timeout. Must NOT be misread as no-tests-ran.
    assert.deepEqual(classifyRunOutcome(result({ totalTests: 4, finishedTests: 4 }), false), {
      kind: 'completed',
    });
  });

  test('fewer finished than registered is a stall', (assert) => {
    assert.deepEqual(classifyRunOutcome(result({ totalTests: 4, finishedTests: 2 }), true), {
      kind: 'stalled',
    });
  });
});
