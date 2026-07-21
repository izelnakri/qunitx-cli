/**
 * Returns a timer object with a `startTime` Date and a `stop()` method that returns elapsed milliseconds.
 * @example
 * ```js
 * import * as TimeCounter from './lib/utils/time-counter.ts';
 * const timer = TimeCounter.start();
 * const ms = timer.stop();
 * console.assert(ms >= 0);
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
