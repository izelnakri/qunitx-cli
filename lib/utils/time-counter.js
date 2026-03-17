/**
 * Returns a timer object with a `startTime` Date and a `stop()` method that returns elapsed milliseconds.
 * @example
 * ```js
 * import timeCounter from './lib/utils/time-counter.js';
 * const t = timeCounter();
 * const ms = t.stop();
 * console.assert(ms >= 0);
 * ```
 * @returns {{ startTime: Date, stop: () => number }}
 */
export default function timeCounter() {
  const startTime = new Date();

  return {
    startTime: startTime,
    stop: () => +new Date() - +startTime,
  };
}
