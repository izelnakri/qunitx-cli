import { module, test } from 'qunitx';
import { closeWithGrace } from '../../lib/utils/close-with-grace.ts';

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
// Lower-bound slack absorbs libuv timer jitter. setTimeout(N) can fire up to a few ms
// before N elapses in wall-clock terms because libuv computes the deadline against its
// per-loop-iteration cached `uv_now`, not a live monotonic read. Local sampling shows
// min ≈ N − 1ms; CI hit N − 0.26ms (run 25088492776). 10ms tolerance is ~10× the worst
// observed, comfortably absorbing jitter without admitting a 0-ms "did we wait?" bug.
const HANG_GRACE_LOWER_BOUND_MS = HANG_GRACE_MS - 10;

module('Commands | run | closeWithGrace', { concurrency: true }, () => {
  test('returns within graceMs when a close never resolves', async (assert) => {
    // Reproduces the Firefox+Windows browser.close() deadlock — an unresolved promise stands
    // in for the stuck Playwright call. Without closeWithGrace, this would block forever.
    const start = performance.now();
    await closeWithGrace([new Promise<void>(() => {})], HANG_GRACE_MS);
    const elapsed = performance.now() - start;

    assert.ok(
      elapsed >= HANG_GRACE_LOWER_BOUND_MS && elapsed < HANG_GRACE_UPPER_BOUND_MS,
      `returned within bounded grace: got ${elapsed} ms, expected ${HANG_GRACE_LOWER_BOUND_MS}–${HANG_GRACE_UPPER_BOUND_MS} ms`,
    );
  });

  test('returns immediately when every close has already settled', async (assert) => {
    const start = performance.now();
    await closeWithGrace([Promise.resolve(), Promise.resolve()], 5_000);
    const elapsed = performance.now() - start;

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
    const start = performance.now();
    await closeWithGrace([], 5_000);
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 50, `empty fast path: ${elapsed} ms`);
  });

  test('writes a single diagnostic line to stderr when the grace timer fires', async (assert) => {
    // Exceptional-condition logging: the user deserves to know shutdown was cut short.
    // Goes to stderr so it never lands in the TAP stream. Pinned here so refactors can't
    // silently regress the visibility of the deadlock.
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };
    try {
      await closeWithGrace([new Promise<void>(() => {})], HANG_GRACE_MS);
    } finally {
      process.stderr.write = originalWrite;
    }

    const output = captured.join('');
    assert.ok(
      output.includes('cleanup timed out'),
      `stderr should mention the timeout: ${JSON.stringify(output)}`,
    );
    assert.ok(
      output.includes(`${HANG_GRACE_MS} ms`),
      `stderr should include the grace value: ${JSON.stringify(output)}`,
    );
  });

  test('does not write to stderr on the fast path', async (assert) => {
    // Mirror of the previous test: when nothing hangs, stderr stays untouched. This
    // guards against the silent-noise failure mode where every clean run emits the line.
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = (chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };
    try {
      await closeWithGrace([Promise.resolve(), Promise.resolve()], 5_000);
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.equal(captured.join(''), '', 'stderr untouched on the fast path');
  });
});
