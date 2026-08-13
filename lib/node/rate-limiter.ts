/**
 * A **token-bucket rate limiter** — the third leg of load protection alongside GenStage
 * (backpressure — slow the source) and the circuit breaker (fail fast — stop calling a broken
 * dependency). A rate limiter *throttles*: it admits work up to a sustained rate with a burst
 * allowance, and rejects the rest, so a single caller can't overwhelm a shared resource.
 *
 * The bucket holds up to `capacity` tokens and refills at `refillPerSec`. `tryAcquire(n)` takes
 * `n` tokens if available (admit) or returns `false` (throttle) — never blocks. `capacity` is the
 * burst size (how many can go at once after idle); `refillPerSec` is the steady-state rate.
 *
 * ```ts
 * const clock = { t: 0 };
 * const limit = rateLimiter({ capacity: 2, refillPerSec: 1, now: () => clock.t });
 * limit.tryAcquire(); // true  — 1 of 2
 * limit.tryAcquire(); // true  — 2 of 2 (burst spent)
 * limit.tryAcquire(); // false — throttled, bucket empty
 * clock.t = 1000; // 1s later → +1 token
 * limit.tryAcquire(); // true
 * ```
 */

/** A running rate limiter — see {@link rateLimiter}. */
export interface RateLimiter {
  /** Take `n` tokens if the bucket has them (admit) and return `true`, else `false` (throttle). */
  tryAcquire(n?: number): boolean;
  /** Tokens available right now (after refilling for elapsed time) — for metrics/introspection. */
  tokens(): number;
}

/**
 * Builds a {@link RateLimiter}. `capacity` is the burst size, `refillPerSec` the sustained rate.
 * `now` is injectable so throttling is testable without real time.
 *
 * ```ts
 * const limit = rateLimiter({ capacity: 5, refillPerSec: 10 });
 * limit.tryAcquire(); // true — starts full
 * ```
 */
export function rateLimiter(options: {
  capacity: number;
  refillPerSec: number;
  now?: () => number;
}): RateLimiter {
  const { capacity, refillPerSec } = options;
  const now = options.now ?? (() => Date.now());
  let tokens = capacity; // start full — an idle limiter admits an immediate burst
  let last = now();

  const refill = (): void => {
    const at = now();
    tokens = Math.min(capacity, tokens + ((at - last) / 1000) * refillPerSec);
    last = at;
  };

  return {
    tryAcquire(n = 1) {
      refill();
      if (tokens >= n) {
        tokens -= n;
        return true;
      }
      return false;
    },
    tokens() {
      refill();
      return tokens;
    },
  };
}
