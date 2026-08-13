/**
 * A **circuit breaker** — Erlang's `:fuse` / Akka's `CircuitBreaker`: stop hammering a failing
 * dependency so it can recover, and fail callers fast instead of piling up doomed calls. Wrap a
 * flaky operation (typically a `node.call` to a peer that may be down or overloaded) and the
 * breaker tracks its health across three states:
 *
 *  - **closed** — normal; calls pass through. Consecutive failures are counted; at `maxFailures`
 *    the breaker trips **open**.
 *  - **open** — the dependency is presumed down; calls are rejected IMMEDIATELY with a declared
 *    `CircuitOpen` failure (no waiting on a doomed call). After `resetTimeoutMs` it goes
 *    **half-open**.
 *  - **half-open** — one probe call is allowed through; concurrent calls are still rejected. If the
 *    probe succeeds the breaker **closes**; if it fails it re-**opens** and the cooldown restarts.
 *
 * This composes with the rest of the failure system: a blocked call rejects with a `Failure`, so
 * it lands in the caller's declared-failure channel exactly like a `CallTimeout` would.
 *
 * ```ts
 * const clock = { t: 0 };
 * const cb = circuitBreaker({ maxFailures: 2, resetTimeoutMs: 100, now: () => clock.t });
 * const boom = () => Promise.reject(new Error('down'));
 * await cb.run(boom).catch(() => {}); // 1 failure
 * await cb.run(boom).catch(() => {}); // 2 → trips
 * cb.state(); // 'open'
 * ```
 */
import { Failure } from '../result/failure.ts';

/** The breaker's health — `closed` passes, `open` fast-fails, `half-open` probes once. */
export type CircuitState = 'closed' | 'open' | 'half-open';

/** A running circuit breaker guarding one dependency — see {@link circuitBreaker}. */
export interface CircuitBreaker {
  /**
   * Run `op` through the breaker: pass through when closed/probing, or reject immediately with a
   * `CircuitOpen` failure when open. `op`'s own rejection propagates unchanged (and counts toward
   * tripping unless `shouldTrip` says otherwise).
   */
  run<T>(op: () => Promise<T>): Promise<T>;
  /** The current state — `closed` | `open` | `half-open`. */
  state(): CircuitState;
  /** Force the breaker back to closed and clear its failure count — `:fuse`'s manual reset. */
  reset(): void;
}

/**
 * Builds a {@link CircuitBreaker}. `maxFailures` consecutive failures trip it; it stays open for
 * `resetTimeoutMs` before a half-open probe. `shouldTrip` classifies which errors count (default:
 * all) — pass it to ignore *expected* declared failures (a `NotFound` shouldn't trip the wire).
 * `now` is injectable so the cooldown is testable without real timers.
 *
 * ```ts
 * const cb = circuitBreaker({ maxFailures: 3 });
 * await cb.run(() => Promise.resolve(42)); // 42 — passes through when closed
 * cb.state(); // 'closed'
 * ```
 */
export function circuitBreaker(
  options: {
    maxFailures?: number;
    resetTimeoutMs?: number;
    shouldTrip?: (error: unknown) => boolean;
    now?: () => number;
  } = {},
): CircuitBreaker {
  const maxFailures = options.maxFailures ?? 5;
  const resetTimeoutMs = options.resetTimeoutMs ?? 10000;
  const shouldTrip = options.shouldTrip ?? (() => true);
  const now = options.now ?? (() => Date.now());

  let state: CircuitState = 'closed';
  let failures = 0;
  let openedAt = 0;
  let probing = false; // a half-open probe is in flight — block concurrent probes

  const open = (): void => {
    state = 'open';
    openedAt = now();
  };
  const close = (): void => {
    state = 'closed';
    failures = 0;
  };

  const onSuccess = (): void => {
    probing = false;
    close();
  };
  const onFailure = (error: unknown): void => {
    probing = false;
    if (!shouldTrip(error)) return; // an expected failure — don't hold it against the dependency
    if (state === 'half-open') return void open(); // probe failed → straight back to open
    if (++failures >= maxFailures) open();
  };

  return {
    async run<T>(op: () => Promise<T>): Promise<T> {
      // A cooled-down open breaker becomes half-open and lets exactly one probe through.
      if (state === 'open' && now() - openedAt >= resetTimeoutMs) state = 'half-open';
      if (state === 'open' || (state === 'half-open' && probing)) {
        throw new Failure('CircuitOpen', 'circuit is open — failing fast', {
          openedForMs: now() - openedAt,
        });
      }
      if (state === 'half-open') probing = true;
      try {
        const value = await op();
        onSuccess();
        return value;
      } catch (error) {
        onFailure(error);
        throw error;
      }
    },
    state: () => state,
    reset: () => {
      probing = false;
      close();
    },
  };
}
