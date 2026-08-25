import { module, test } from 'qunitx';
import { closeCompletely, closeWithGrace } from '../../lib/utils/close-with-grace.ts';
import '../helpers/custom-asserts.ts';

// Giving up on a close is not the same as being done with it. A watch session that restarts tears
// down a session of its own, and if that teardown hit the grace, the closes it walked away from
// are still holding handles — with nothing left that knows about them, because the session that
// owned them has been replaced. That is a process that never exits.
module('Utils | closeWithGrace', { concurrency: true }, () => {
  const never = () => new Promise<void>(() => {});
  const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  test('everything settling in time abandons nothing', async (assert) => {
    const abandoned = await closeWithGrace({ server: Promise.resolve(), page: after(1) }, 5_000);

    assert.deepEqual(abandoned.names, []);
    await abandoned.settled;
    assert.ok(true, 'settled is already settled, so awaiting it cannot hang');
  });

  test('a rejected close is settled, not abandoned', async (assert) => {
    // A close that FAILS has finished — it is holding nothing. Only one still running is a leak,
    // so a rejection must not be reported as something to wait for.
    const abandoned = await closeWithGrace({ wedged: Promise.reject(new Error('boom')) }, 5_000);

    assert.deepEqual(abandoned.names, [], 'a failure is an ending');
  });

  test('the names say which closes were abandoned, and only those', async (assert) => {
    const abandoned = await closeWithGrace(
      { server: Promise.resolve(), page: never(), browser: never(), esbuild: null },
      20,
    );

    assert.deepEqual(
      abandoned.names.sort(),
      ['browser', 'page'],
      'the one that settled is not named, and a null entry is not a close at all',
    );
  });

  test('settled resolves when the abandoned closes finally finish', async (assert) => {
    // The whole point: the caller can come back for what this gave up on. Without it those closes
    // are unreachable — still running, still holding their handles, with no one left to await.
    let release = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const abandoned = await closeWithGrace({ browser: slow }, 20);

    assert.deepEqual(abandoned.names, ['browser'], 'it was given up on');

    let finished = false;
    const waiting = abandoned.settled.then(() => {
      finished = true;
    });
    await after(10);
    assert.notOk(finished, 'and it is still running — that is the leak this hands back');

    release();
    await waiting;
    assert.ok(finished, 'so a caller can wait for the handles to actually go');
  });
});

// The bug this exists for, from a release build's Windows job:
//
//   ✖ no handle outlives the run, so a script that calls it can exit
//   LEAKED-HANDLES [… "ProcessWrap","Timeout"]  pipe → \\?\pipe\uv\1-11252, 2-11252, process
//   # qunitx: cleanup timed out after 10000 ms — still pending: browser
//
// Two pipes and a process handle is playwright's browser transport. `run()` returned while
// `browser.close()` was still in flight, so the script that awaited it could not end. Ten of those
// cleanup-timeout lines appear in that one job and only ONE test failed — the close is slow, not
// deadlocked, and a caller that waits gets a clean process.
module('Utils | closeCompletely', { concurrency: true }, () => {
  const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  test('a close that outlives the first grace is waited for, not abandoned', async (assert) => {
    // 40ms against a 30ms grace: past the first wait, inside the second. The budget really is two
    // graces, not one — a close slower than both is the deadlock case, covered separately below.
    let closed = false;
    const slow = after(40).then(() => void (closed = true));

    const pending = await closeCompletely({ browser: slow }, 30);

    assert.deepEqual(pending, [], 'nothing is still running when this answers');
    assert.ok(closed, 'and the slow close really did finish before it did');
  });

  test('the fast path costs nothing extra', async (assert) => {
    const started = Date.now();

    const pending = await closeCompletely({ server: Promise.resolve() }, 5_000);

    assert.deepEqual(pending, []);
    assert.ok(
      Date.now() - started < 1_000,
      'a clean close does not wait out a grace it never needed',
    );
  });

  test('a close that never finishes is named rather than waited on forever', async (assert) => {
    // The other half of the contract: bounded twice, so a genuine deadlock cannot wedge a caller.
    const pending = await closeCompletely({ browser: new Promise<void>(() => {}) }, 20);

    assert.deepEqual(pending, ['browser'], 'so the caller can say what is holding the process');
  });
});
