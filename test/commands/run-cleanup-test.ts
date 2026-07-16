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

// The grace used by the hanging-close scenarios. Kept small so the suite stays fast.
const HANG_GRACE_MS = 100;

module('Commands | run | closeWithGrace', { concurrency: true }, () => {
  test('is bounded by the grace timer, not by a hanging close', async (assert) => {
    // Reproduces the Firefox+Windows browser.close() deadlock: a close that only settles when we
    // say so stands in for the stuck Playwright call.
    let closeSettled = false;
    let settleClose = () => {};
    const hangingClose = new Promise<void>((resolve) => {
      settleClose = () => {
        closeSettled = true;
        resolve();
      };
    });

    const start = performance.now();
    await closeWithGrace([hangingClose], HANG_GRACE_MS);
    const elapsed = performance.now() - start;

    try {
      // Bounded by grace, not the close: the close is still pending, so the grace timer is what
      // returned us. Pure ordering — no wall clock, immune to load.
      assert.ok(!closeSettled, 'returned while the hanging close was still pending');
      // It actually waited the grace. Only a LOWER bound is load-stable: a timer fires at most
      // ~1 ms early and under load only later, so starvation can never break this — unlike the
      // previous 300 ms UPPER bound, which a loaded runner blew past (821 ms, run 29469560203).
      // 10 ms is ~12× the worst early-fire seen.
      assert.ok(
        elapsed >= HANG_GRACE_MS - 10,
        `waited for the grace timer rather than short-circuiting: got ${elapsed} ms`,
      );
    } finally {
      settleClose(); // let the dangling close settle so it doesn't leak into the next test
    }
  });

  test('returns immediately when every close has already settled', async (assert) => {
    // The fast path resolves on microtasks, which always drain before the loop reaches the timer
    // phase — so it completes before even a 0 ms timer, however loaded the machine is. (An earlier
    // `elapsed < 50 ms` assertion was the same load-fragile shape as the hanging-close flake.)
    let timerFired = false;
    const timer = setTimeout(() => (timerFired = true), 0);
    await closeWithGrace([Promise.resolve(), Promise.resolve()], 5_000);
    clearTimeout(timer);

    assert.ok(!timerFired, 'fast path resolved on microtasks, before a 0 ms timer could fire');
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
    // Defensive: caller might filter all closers away (e.g. no sharedServer), and the helper must
    // not block on an empty Promise.allSettled. Same microtask-before-timer ordering as above.
    let timerFired = false;
    const timer = setTimeout(() => (timerFired = true), 0);
    await closeWithGrace([], 5_000);
    clearTimeout(timer);

    assert.ok(
      !timerFired,
      'empty fast path resolved on microtasks, before a 0 ms timer could fire',
    );
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
