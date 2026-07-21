import { module, test } from 'qunitx';
import { spawn } from '../../lib/chrome/spawn.ts';
import type { ChromeHandle } from '../../lib/types.ts';

// Regression coverage for issue #50. `shutdown` closes over only proc + userDataDir, both known at
// spawn, so spawn hands back a FULL handle synchronously via onSpawn — before the CDP
// endpoint is known. That is what lets chrome-prelaunch.ts keep one `earlyChrome` variable with a
// null-or-realized invariant instead of two. The failure mode this guards: a Chrome that dies
// before CDP-ready must still yield a callable `shutdown` that reaps without throwing. A naive
// collapse (earlyChrome partial, shutdown absent in that window) would `undefined()` here.
//
// A real Chrome binary is not needed: `process.execPath` (node) spawned with Chrome's flags
// rejects them and exits immediately, never printing a "DevTools listening on ws://" line — a
// faithful, deterministic stand-in for "spawned, then died before CDP-ready".
const FAKE_CHROME = process.execPath;

module('Chrome | spawn shutdown handle', { concurrency: true }, () => {
  test('delivers a complete, callable handle synchronously at spawn', async (assert) => {
    let handleAtSpawn: ChromeHandle | undefined;
    const result = await spawn(FAKE_CHROME, [], true, (handle) => {
      handleAtSpawn = handle;
    });

    assert.ok(handleAtSpawn, 'onSpawn fired before spawn resolved');
    assert.ok(handleAtSpawn!.proc, 'the handle carries the spawned process');
    assert.equal(typeof handleAtSpawn!.shutdown, 'function', 'and a callable shutdown — pre-CDP');
    assert.equal(result, null, 'a Chrome that never prints a CDP endpoint resolves null');
  });

  test('shutdown() on a Chrome that died before CDP-ready resolves without throwing', async (assert) => {
    let handle: ChromeHandle | undefined;
    await spawn(FAKE_CHROME, [], true, (h) => {
      handle = h;
    });

    // The exact footgun the naive one-variable collapse would reintroduce: shutdown missing here.
    await handle!.shutdown();
    assert.ok(true, 'shutdown completed cleanly on an already-dead process');

    // Idempotent: the exit-handler safety net may also fire, so a second call must be harmless.
    await handle!.shutdown();
    assert.ok(true, 'a second shutdown is a no-op, not a crash');
  });

  test('returns null immediately when no chrome path is given', async (assert) => {
    let spawned = false;
    const result = await spawn(null, [], true, () => {
      spawned = true;
    });
    assert.equal(result, null, 'no path → no launch');
    assert.notOk(spawned, 'onSpawn never fires when nothing is spawned');
  });
});
