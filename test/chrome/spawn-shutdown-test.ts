import { module, test } from 'qunitx';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

  // A signal death leaves exitCode null, so shutdown() used to await a `close` that had already
  // fired — forever. The daemon hit it when Chrome died mid-connectOverCDP: the fallback launch
  // waited on shutdownPrelaunch() and the run hung until the harness killed it.
  test('shutdown() on a Chrome SIGKILLed after CDP-ready resolves', async (assert) => {
    if (process.platform === 'win32') return assert.ok(true, 'skipped: needs a POSIX script');

    const dir = await mkdtemp(path.join(os.tmpdir(), 'qunitx-fake-chrome-'));
    try {
      const fakeChrome = path.join(dir, 'chrome');
      await writeFile(
        fakeChrome,
        '#!/bin/sh\necho "DevTools listening on ws://127.0.0.1:1/devtools/browser/x" >&2\nexec sleep 60\n',
        { mode: 0o755 },
      );
      const chrome = await spawn(fakeChrome, []);
      assert.ok(chrome, 'resolved an EarlyChrome once the CDP line was printed');

      const closed = new Promise((resolve) => chrome!.proc.once('close', resolve));
      process.kill(-chrome!.proc.pid!, 'SIGKILL');
      await closed;

      const outcome = await Promise.race([
        chrome!.shutdown().then(() => 'resolved'),
        new Promise((resolve) => setTimeout(resolve, 5_000, 'hung')),
      ]);
      assert.equal(outcome, 'resolved', 'shutdown does not wait for a close that already fired');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // `close` waits for every holder of Chrome's stderr, and a helper Chrome started in a session of
  // its own outlives the group kill holding it. shutdown() then waited on a `close` that would
  // never come, with nothing else keeping the loop alive, and `record` exited 0 having done
  // nothing — CI's "launching chromium" with an empty stderr.
  test('shutdown() resolves when a helper outside the group still holds stderr open', async (assert) => {
    if (process.platform !== 'linux') return assert.ok(true, 'skipped: needs setsid');

    const dir = await mkdtemp(path.join(os.tmpdir(), 'qunitx-fake-chrome-'));
    const helperPid = path.join(dir, 'helper.pid');
    try {
      const fakeChrome = path.join(dir, 'chrome');
      await writeFile(
        fakeChrome,
        // The helper is started, and out of the group, before Chrome says it's ready.
        `#!/bin/sh\nsetsid sh -c 'echo $$ > "${helperPid}"; exec sleep 60' &\n` +
          `while [ ! -s "${helperPid}" ]; do sleep 0.05; done\n` +
          'echo "DevTools listening on ws://127.0.0.1:1/devtools/browser/x" >&2\nexec sleep 60\n',
        { mode: 0o755 },
      );
      const chrome = await spawn(fakeChrome, []);
      assert.ok(chrome, 'resolved an EarlyChrome once the CDP line was printed');

      const outcome = await Promise.race([
        chrome!.shutdown().then(() => 'resolved'),
        new Promise((resolve) => setTimeout(resolve, 5_000, 'hung')),
      ]);
      assert.equal(outcome, 'resolved', 'shutdown waits for Chrome to exit, not for its pipe');
    } finally {
      const pid = Number(await readFile(helperPid, 'utf8').catch(() => ''));
      if (pid) process.kill(pid, 'SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
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
