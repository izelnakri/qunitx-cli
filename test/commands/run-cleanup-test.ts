import { module, test } from 'qunitx';
import { closeWithGrace } from '../../lib/commands/run.ts';

// These tests pin the behavior that prevents a hanging Playwright `browser.close()` from
// wedging the CLI shutdown indefinitely on Firefox + Windows. The previous inline
// `await Promise.all([server.close(), browser.close()])` had no escape valve — when
// browser.close() deadlocked (a documented Playwright Firefox/Windows pattern), the CLI
// stayed alive until the test runner's 60 s exec timeout SIGTERM'd it. closeWithGrace
// races the cleanup against an explicit timer so the CLI exits in bounded time.
//
// Each scenario uses Promise primitives only — no Playwright, no real shutdown — so the
// behavior is verified in milliseconds and adds < 1 s to the test suite.

const HANG_GRACE_MS = 100;
// Generous slack on the upper bound: CI runners under load can blow past tight numbers
// without indicating any real bug. A hanging close that returns within ~3× HANG_GRACE_MS
// still proves the helper is bounded — which is the only contract that matters here.
const HANG_GRACE_UPPER_BOUND_MS = 300;

module('Commands | run | closeWithGrace', { concurrency: true }, () => {
  test('returns within graceMs when a close never resolves', async (assert) => {
    // Reproduces the Firefox+Windows browser.close() deadlock — an unresolved promise stands
    // in for the stuck Playwright call. Without closeWithGrace, this would block forever.
    const start = Date.now();
    await closeWithGrace([new Promise<void>(() => {})], HANG_GRACE_MS);
    const elapsed = Date.now() - start;

    assert.ok(
      elapsed >= HANG_GRACE_MS && elapsed < HANG_GRACE_UPPER_BOUND_MS,
      `returned within bounded grace: got ${elapsed} ms, expected ${HANG_GRACE_MS}–${HANG_GRACE_UPPER_BOUND_MS} ms`,
    );
  });

  test('returns immediately when every close has already settled', async (assert) => {
    const start = Date.now();
    await closeWithGrace([Promise.resolve(), Promise.resolve()], 5_000);
    const elapsed = Date.now() - start;

    assert.ok(
      elapsed < 50,
      `fast path: did not wait the grace period when nothing was hanging (got ${elapsed} ms)`,
    );
  });

  test('does not throw when a close rejects', async (assert) => {
    // Promise.allSettled never rejects, so a single failing close cannot wedge cleanup —
    // and crucially, the caller does not have to wrap each close in its own .catch().
    await closeWithGrace([Promise.reject(new Error('boom'))], HANG_GRACE_MS);
    assert.ok(true, 'rejection from a close was swallowed cleanly');
  });

  test('awaits every close when none hang', async (assert) => {
    let completed = 0;
    const finishingClose = (delayMs: number) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          completed++;
          resolve();
        }, delayMs);
      });

    await closeWithGrace([finishingClose(10), finishingClose(20), finishingClose(30)], 5_000);

    assert.equal(completed, 3, 'all three closes ran to completion before the function returned');
  });

  test('returns immediately when the close list is empty', async (assert) => {
    // Defensive: caller might filter all closers away (e.g. no sharedServer), and the helper
    // must not block on an empty Promise.allSettled.
    const start = Date.now();
    await closeWithGrace([], 5_000);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 50, `empty fast path: ${elapsed} ms`);
  });
});
