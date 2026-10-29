import { module, test } from 'qunitx';
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
    const capture = Capture.start(slowPage(5), { fps: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stoppedAt = performance.now();
    await capture.stop();

    // At 1 fps the timed loop is 950ms into a wait: stopping cuts it short.
    assert.true(performance.now() - stoppedAt < 500, `${performance.now() - stoppedAt}ms`);
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
