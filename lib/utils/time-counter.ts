/**
 * Returns a timer object with a `startTime` Date and a `stop()` method that returns elapsed milliseconds.
 *
 * ```ts
 * import * as TimeCounter from './time-counter.ts';
 *
 * const timer = TimeCounter.start();
 * timer.stop(); // elapsed milliseconds since start() — ≥ 0
 * ```
 * @returns {{ startTime: Date, stop: () => number }}
 */
export function start(): { startTime: Date; stop: () => number } {
  const startTime = new Date();

  return {
    startTime: startTime,
    stop: () => +new Date() - +startTime,
  };
}
