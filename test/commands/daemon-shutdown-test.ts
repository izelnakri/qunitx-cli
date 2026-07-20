import { module, test } from 'qunitx';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { shutdownDaemon, removeLivenessFiles } from '../../lib/commands/daemon/server.ts';
import '../helpers/custom-asserts.ts';

// Regression for the flaky `a short QUNITX_DAEMON_IDLE_TIMEOUT ... self-exits` integration test
// (run 29469560203). On idle shutdown the daemon removes its liveness markers (info/socket/lock),
// which is how a client — and that test's `waitForFileGone` — detects "daemon gone". Those
// unlinks used to sit in the same batch as browser.close(), AFTER a bounded wait (up to 3 s) for
// the pre-launched Chrome to settle. On a loaded runner whose Chrome hadn't settled, a self-exited
// daemon kept its info file for ~3 s, so a 500 ms idle timeout could exceed the test's 3 s window.
//
// These tests pin the fix deterministically, with no real Chrome and no wall-clock threshold:
// the info file must be gone while the browser launch is still pending.

type DaemonStateArg = Parameters<typeof shutdownDaemon>[0];

// A daemon state with a browser launch that never settles on its own — stands in for a slow or
// hung pre-launched Chrome. `settleBrowser` lets the test release it after asserting, so
// shutdownDaemon can finish and call the injected exit instead of dangling on the 3 s grace.
function fakeState(
  paths: { socketPath: string; infoPath: string; lockPath: string },
  listenSucceeded = true,
): { state: DaemonStateArg; settleBrowser: () => void } {
  let settleBrowser = () => {};
  const browserReady = new Promise<null>((resolve) => {
    settleBrowser = () => resolve(null);
  });
  const state = {
    shuttingDown: false,
    idleTimer: null,
    pendingClients: new Set(),
    socketServer: { close: (cb: () => void) => cb() },
    browser: null,
    browserReady,
    pageSlot: { page: null },
    esbuildCache: { context: null },
    listenSucceeded,
    ...paths,
  } as unknown as DaemonStateArg;
  return { state, settleBrowser };
}

async function tempPaths(): Promise<{ socketPath: string; infoPath: string; lockPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qunitx-daemon-shutdown-'));
  const paths = {
    socketPath: path.join(dir, 'daemon.sock'),
    infoPath: path.join(dir, 'info.json'),
    lockPath: path.join(dir, 'daemon.lock'),
  };
  await Promise.all(Object.values(paths).map((p) => writeFile(p, '{}')));
  return paths;
}

function waitForGone(filePath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(filePath)) return resolve(true);
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      if (!existsSync(filePath)) {
        clearInterval(poll);
        resolve(true);
      } else if (Date.now() >= deadline) {
        clearInterval(poll);
        resolve(false);
      }
    }, 10);
  });
}

module('Commands | Daemon | shutdown', { concurrency: true }, () => {
  test('removes the info/socket/lock files before the browser teardown', async (assert) => {
    const paths = await tempPaths();
    const { state, settleBrowser } = fakeState(paths);
    let exited = false;

    // Don't await: with the browser launch left pending, shutdownDaemon reaches the (bounded)
    // browser grace and parks there. The fix removes the liveness files *before* that park, so
    // they must vanish while the browser is still pending. The 2 s budget is far below the 3 s
    // grace an unfixed daemon would wait, and far above the fs unlink's real cost — so it fails
    // cleanly on the old ordering without racing on the new one.
    const done = shutdownDaemon(state, 'test', () => {
      exited = true;
    });

    // removeLivenessFiles unlinks the three markers concurrently (one Promise.all) with no
    // ordering guarantee, so poll for each rather than assuming that once info is gone the other
    // two are visibly gone too. They resolve out of order ~12% of the time, and on APFS/Deno the
    // on-disk visibility of the laggards trails info's — an `existsSync` here flaked on exactly
    // that. All three are still removed before the browser park, so each vanishes well within the
    // budget; the point being pinned is "before the browser teardown", not their relative order.
    const [infoGone, socketGone, lockGone] = await Promise.all([
      waitForGone(paths.infoPath, 2_000),
      waitForGone(paths.socketPath, 2_000),
      waitForGone(paths.lockPath, 2_000),
    ]);
    assert.ok(infoGone, 'info file removed while the browser launch was still pending');
    assert.ok(socketGone, 'socket file removed too');
    assert.ok(lockGone, 'lock file removed too');
    assert.notOk(exited, 'still mid-shutdown: exit() not reached until the browser settles');

    settleBrowser(); // release the launch so shutdown finishes cleanly
    await done;
    assert.ok(exited, 'exit() runs once the browser teardown completes');
  });

  test('removeLivenessFiles keeps socket/info when the daemon never bound, always drops the lock', async (assert) => {
    // A daemon that threw before listen() doesn't own socket/info — unlinking them would corrupt
    // whatever started in its place — but the lock is always ours to release.
    const paths = await tempPaths();
    const { state } = fakeState(paths, /* listenSucceeded */ false);

    await removeLivenessFiles(state);

    assert.ok(existsSync(paths.socketPath), 'socket kept: not ours when listen never succeeded');
    assert.ok(existsSync(paths.infoPath), 'info kept: not ours when listen never succeeded');
    assert.notOk(existsSync(paths.lockPath), 'lock always released');
  });
});
