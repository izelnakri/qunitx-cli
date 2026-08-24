import { module, test } from 'qunitx';
import { closeWithGrace } from '../../lib/utils/close-with-grace.ts';
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
