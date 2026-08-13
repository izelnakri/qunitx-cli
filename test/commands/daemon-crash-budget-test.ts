import { module, test } from 'qunitx';
import * as Server from '../../lib/commands/daemon/server.ts';
import '../helpers/custom-asserts.ts';

// The crash budget is CONSECUTIVE: a daemon that recovers and then serves a run is healthy,
// however many times it crashed before. That property used to be checked only end to end — kill
// Chrome, run, kill Chrome, run, assert the daemon survived — which meant two real browser
// relaunches inside one test. On a loaded deno runner that exceeded the per-test deadline and
// surfaced as an unattributable timeout, so the most important invariant in the daemon was also
// the least reliable thing in the suite.
//
// Here it is arithmetic on the same function the server calls, in microseconds. The end-to-end
// test still proves a real relaunch works; it no longer has to prove the counting too.

type Counter = { consecutiveCrashes: number };

module('Commands | Daemon | crash budget', { concurrency: true }, () => {
  test('a connected browser resets the counter and asks for nothing', (assert) => {
    const state: Counter = { consecutiveCrashes: 1 };

    assert.strictEqual(Server.noteBrowserOutcome(state, true), 'ok');
    assert.strictEqual(state.consecutiveCrashes, 0, 'reset, not decremented');
  });

  test('a crash increments and asks for a relaunch, up to the budget', (assert) => {
    const state: Counter = { consecutiveCrashes: 0 };

    assert.strictEqual(Server.noteBrowserOutcome(state, false), 'relaunch', 'crash 1');
    assert.strictEqual(state.consecutiveCrashes, 1);
    assert.strictEqual(Server.noteBrowserOutcome(state, false), 'relaunch', 'crash 2');
    assert.strictEqual(state.consecutiveCrashes, 2);
  });

  test('one crash past the budget shuts the daemon down', (assert) => {
    const state: Counter = { consecutiveCrashes: 2 };

    assert.strictEqual(Server.noteBrowserOutcome(state, false), 'shutdown');
  });

  test('THE CLAIM: a successful run between crashes lets the daemon survive both', (assert) => {
    // Exactly the scenario the end-to-end test spends two Chrome relaunches on. Without the
    // reset, the second cycle's crash would be the third consecutive one and shut the daemon
    // down; with it, every crash is the first.
    const state: Counter = { consecutiveCrashes: 0 };
    const trail: string[] = [];

    for (const cycle of [1, 2]) {
      trail.push(`${cycle}:${Server.noteBrowserOutcome(state, false)}`); // Chrome killed
      trail.push(`${cycle}:${Server.noteBrowserOutcome(state, true)}`); // run succeeds
    }

    assert.deepEqual(trail, ['1:relaunch', '1:ok', '2:relaunch', '2:ok'], 'never shut down');
    assert.strictEqual(state.consecutiveCrashes, 0, 'and the counter ends clean');
  });

  test('without a successful run between them, the same two cycles DO shut it down', (assert) => {
    // The control: proves the previous test is actually testing the reset rather than a budget
    // that happens to be generous.
    const state: Counter = { consecutiveCrashes: 0 };
    const trail = [false, false, false].map((c) => Server.noteBrowserOutcome(state, c));

    assert.deepEqual(trail, ['relaunch', 'relaunch', 'shutdown']);
  });
});
