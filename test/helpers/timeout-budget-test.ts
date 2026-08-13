import { module, test } from 'qunitx';
import { PER_TEST_TIMEOUT_MS } from './per-test-timeout.ts';
import { CHROME_RELAUNCH_TIMEOUT_MS, DEFAULT_EXEC_TIMEOUT_MS } from './shell.ts';
import '../helpers/custom-asserts.ts';

// The suite has two nested deadlines, and per-test-timeout.ts states the contract between them:
// a per-CALL budget cuts off one `cli()` invocation, and PER_TEST_TIMEOUT_MS is "the outer safety
// net for the test itself". That only holds while every inner budget is STRICTLY smaller.
//
// It stopped holding: CHROME_RELAUNCH_TIMEOUT_MS was raised 180s -> 300s to stop a cli timeout,
// which made it equal to the outer net. From then on a slow call could not fail attributably —
// both deadlines expired at the same instant and the harness reported an opaque
// "test exceeded 300000ms" with no indication of WHICH call hung. The flake was not fixed, it
// was disguised, and it resurfaced the moment deno-lane contention rose.
//
// This test is the guard. It is arithmetic, not timing, so it can never itself be flaky.

module('Helpers | timeout budgets', { concurrency: true }, () => {
  const PER_CALL = { DEFAULT_EXEC_TIMEOUT_MS, CHROME_RELAUNCH_TIMEOUT_MS };

  test('every per-call budget is strictly below the per-test net', (assert) => {
    for (const [name, budget] of Object.entries(PER_CALL)) {
      assert.true(
        budget < PER_TEST_TIMEOUT_MS,
        `${name} (${budget}ms) must be < PER_TEST_TIMEOUT_MS (${PER_TEST_TIMEOUT_MS}ms), ` +
          `or a slow call reports as an unattributable test timeout`,
      );
    }
  });

  test('when the largest per-call budget fires, the test can still surface it', (assert) => {
    // Attributability needs more than "smaller": a call that hangs must fail far enough inside
    // the net that the test around it still has time to assert, clean up and report by name.
    // Sixty seconds is the margin — comfortably more than any teardown in this suite.
    const largest = Math.max(...Object.values(PER_CALL));
    const headroom = PER_TEST_TIMEOUT_MS - largest;

    assert.true(
      headroom >= 60_000,
      `the largest per-call budget (${largest}ms) leaves only ${headroom}ms inside ` +
        `PER_TEST_TIMEOUT_MS (${PER_TEST_TIMEOUT_MS}ms); a hung call would race the outer net`,
    );
  });
});
