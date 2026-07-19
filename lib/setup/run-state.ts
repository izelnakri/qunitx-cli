import type { Counter, RunResults, RunState } from '../types.ts';

/** A zeroed outcome counter. */
function newCounter(): Counter {
  return {
    testCount: 0,
    failCount: 0,
    skipCount: 0,
    todoCount: 0,
    passCount: 0,
    errorCount: 0,
  };
}

/** Fresh run state for a single `qunitx` invocation. Built once per run in `setupConfig()`. */
export function newRunState(): RunState {
  return { results: { counter: newCounter() } };
}

/**
 * Clears the run accumulators **in place** for a re-run.
 *
 * In place, not by replacement: concurrent group configs share this object by reference (the
 * group spread is shallow), so assigning a fresh `results` on one config would detach it from
 * the others and split the run's totals across several objects.
 */
export function resetRunResults(results: RunResults): void {
  Object.assign(results.counter, newCounter());
}
