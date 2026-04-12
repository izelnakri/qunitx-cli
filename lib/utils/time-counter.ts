/**
 * Returns a timer object with a `startTime` Date and a `stop()` method that returns elapsed milliseconds.
 * @example
 * ```js
 * import timeCounter from './lib/utils/time-counter.ts';
 * const timer = timeCounter();
 * const ms = timer.stop();
 * console.assert(ms >= 0);
 * ```
 * @returns {{ startTime: Date, stop: () => number }}
 */
export default function timeCounter(): { startTime: Date; stop: () => number } {
  const startTime = new Date();

  return {
    startTime: startTime,
    stop: () => +new Date() - +startTime,
  };
}
