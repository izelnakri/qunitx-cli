import { module, test } from 'qunitx';
import { rateLimiter } from '../../lib/node/index.ts';

module('Node | rate limiter', { concurrency: true }, () => {
  test('starts full — admits a burst up to capacity, then throttles', (assert) => {
    const clock = { t: 0 };
    const limit = rateLimiter({ capacity: 3, refillPerSec: 1, now: () => clock.t });
    assert.true(limit.tryAcquire(), '1 of 3');
    assert.true(limit.tryAcquire(), '2 of 3');
    assert.true(limit.tryAcquire(), '3 of 3 — burst spent');
    assert.false(limit.tryAcquire(), 'throttled: bucket empty');
  });

  test('refills at refillPerSec over elapsed time', (assert) => {
    const clock = { t: 0 };
    const limit = rateLimiter({ capacity: 2, refillPerSec: 4, now: () => clock.t });
    limit.tryAcquire();
    limit.tryAcquire();
    assert.false(limit.tryAcquire(), 'empty');
    clock.t = 250; // 0.25s * 4/s = 1 token
    assert.true(limit.tryAcquire(), 'one token refilled');
    assert.false(limit.tryAcquire(), 'and only one');
  });

  test('refill never exceeds capacity (no unbounded accrual while idle)', (assert) => {
    const clock = { t: 0 };
    const limit = rateLimiter({ capacity: 2, refillPerSec: 10, now: () => clock.t });
    clock.t = 10_000; // idle a long time
    assert.equal(limit.tokens(), 2, 'capped at capacity, not 100');
  });

  test('tryAcquire(n) takes multiple tokens atomically', (assert) => {
    const clock = { t: 0 };
    const limit = rateLimiter({ capacity: 5, refillPerSec: 1, now: () => clock.t });
    assert.true(limit.tryAcquire(3), 'took 3 of 5');
    assert.false(limit.tryAcquire(3), 'only 2 left — rejected, and NOT partially taken');
    assert.true(limit.tryAcquire(2), 'the remaining 2 are still there');
  });
});
