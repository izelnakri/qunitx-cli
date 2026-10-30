import { module, test } from 'qunitx';
import { setTimeout as delay } from 'node:timers/promises';
import * as Capture from '../../lib/record/capture.ts';
import type { Page } from 'playwright-core';

// A page whose screenshot takes `ms`: the capture only ever asks it for one.
function slowPage(ms: number): Page {
  return {
    screenshot: () => new Promise((resolve) => setTimeout(() => resolve(new Uint8Array(4)), ms)),
  } as unknown as Page;
}

module('Record | capture', { concurrency: true }, () => {
  test('start(page) takes DEFAULT_FPS frames a second at most; snap and stop work as functions too', async (assert) => {
    const capture = Capture.start(slowPage(1));
    await new Promise((resolve) => setTimeout(resolve, 250));
    await Capture.snap(capture);
    const shots = await Capture.stop(capture);
    const timed = shots.filter((shot) => !shot.requested);

    // 250ms at 10 fps: a frame at 0, 100 and 200ms, then the last one stop() takes.
    assert.true(timed.length >= 3 && timed.length <= 5, `${timed.length} timed frames`);
    assert.strictEqual(shots.filter((shot) => shot.requested).length, 1, 'the snapped frame');
    assert.deepEqual(
      shots.map((shot) => shot.atMs),
      shots.map((shot) => shot.atMs).toSorted((a, b) => a - b),
      'in the order they were taken',
    );
  });

  test('stop() returns once the shot in flight ends, not after the rest of its interval', async (assert) => {
    // One frame an hour: once the first shot is in, stop() can only return by cutting that wait
    // short, so the test holds on any machine, however loaded. The guard keeps a regression a
    // failure, not an hour-long hang.
    const capture = Capture.start(slowPage(5), { fps: 1 / 3600 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const guard = new AbortController();
    const outcome = await Promise.race([
      capture.stop().then((shots) => shots.length),
      delay(60_000, 'still waiting', { signal: guard.signal }),
    ]);
    guard.abort();

    assert.strictEqual(outcome, 2, 'the first shot and the one stop() takes');
  });
});

module('Record | capture | limitFrameRate', { concurrency: true }, () => {
  test('shots are kept no closer than 1000 / fps ms to the last one kept, and the final shot always', (assert) => {
    const shots = [0, 40, 80, 120, 160, 200, 230].map((atMs) => ({ png: new Uint8Array(0), atMs }));

    assert.deepEqual(
      Capture.limitFrameRate(shots, 10).map((shot) => shot.atMs),
      [0, 120, 230],
    );
    assert.deepEqual(
      Capture.limitFrameRate(shots.slice(0, 1), 10).map((shot) => shot.atMs),
      [0],
    );
    const requested = [{ atMs: 0 }, { atMs: 30, requested: true }, { atMs: 60 }, { atMs: 200 }].map(
      (shot) => ({
        png: new Uint8Array(0),
        ...shot,
      }),
    );
    assert.deepEqual(
      Capture.limitFrameRate(requested, 10).map((shot) => shot.atMs),
      [0, 30, 200],
      'a shot the script asked for is never dropped',
    );
  });
});
