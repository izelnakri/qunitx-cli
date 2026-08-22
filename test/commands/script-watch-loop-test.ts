import { module, test } from 'qunitx';
import { watchLoop } from '../../lib/commands/run.ts';
import '../helpers/custom-asserts.ts';

// The watch hang these guard: two `execute()` calls against one page navigate over each other and
// neither finishes. It only reproduced on a loaded Windows runner, where the first run is slow
// enough to still be going when the first save lands — so the guarantee is pinned here, with the
// filesystem injected out, rather than left to a 210s end-to-end timeout to notice.
const deferred = () => {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => (release = resolve));

  return { promise, release };
};

module('Commands | script | watchLoop', { concurrency: true }, () => {
  test('runs once on its own, without waiting for a change', async (assert) => {
    let runs = 0;
    const watching = watchLoop(
      [],
      () => {
        runs++;
        return Promise.resolve();
      },
      () => {},
      0,
    );
    // The loop never resolves; race it against a turn of the event loop.
    await Promise.race([
      watching.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 10)),
    ]);

    assert.strictEqual(runs, 1);
  });

  test('a change during the FIRST run does not start a second concurrent run', async (assert) => {
    const firstRun = deferred();
    let started = 0;
    let concurrent = 0;
    let active = 0;
    let fire: () => void = () => {};

    const watching = watchLoop(
      ['/watched'],
      async () => {
        started++;
        active++;
        if (active > 1) concurrent++;
        if (started === 1) await firstRun.promise;
        active--;
      },
      (_directory, listener) => (fire = listener),
      0,
    );
    void watching.catch(() => {});

    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.strictEqual(started, 1, 'the first run is already going');

    fire(); // a save lands while the first run is still in flight
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(started, 1, 'the change waits rather than running alongside');

    firstRun.release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(started, 2, 'the remembered change runs after the first finishes');
    assert.strictEqual(concurrent, 0, 'no two runs ever overlapped');
  });

  test('rejects when the first run fails, so a script that never started is reported', async (assert) => {
    const boom = new Error('build failed');
    const watching = watchLoop(
      [],
      () => Promise.reject(boom),
      () => {},
      0,
    );

    await watching.then(
      () => assert.ok(false, 'expected the first-run failure to reject'),
      (error) => assert.strictEqual(error, boom),
    );
  });

  test('keeps watching when a LATER run fails', async (assert) => {
    let runs = 0;
    let fire: () => void = () => {};
    let settled = false;
    const watching = watchLoop(
      ['/watched'],
      () => {
        runs++;
        return runs === 2 ? Promise.reject(new Error('bad edit')) : Promise.resolve();
      },
      (_directory, listener) => (fire = listener),
      0,
    );
    watching.then(
      () => (settled = true),
      () => (settled = true),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    fire();
    await new Promise((resolve) => setTimeout(resolve, 20));
    fire();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(runs, 3, 'a failing edit does not stop later ones');
    assert.notOk(settled, 'the watch is still live');
  });
});
