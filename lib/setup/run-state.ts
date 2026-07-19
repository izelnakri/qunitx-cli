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
  return {
    reporters: [],
    results: {
      counter: newCounter(),
      failedFiles: new Set(),
      failedTests: [],
      coverage: null,
    },
  };
}

/**
 * Clears the run accumulators **in place** for a re-run.
 *
 * In place, not by replacement: concurrent group configs share the `results` object by reference
 * (the group spread is shallow), so assigning a fresh `results` on one config would detach it from
 * the others and split the run's totals across several objects. Assigning `results.coverage` is
 * safe for the same reason — it mutates a field of the shared object rather than replacing it.
 */
export function resetRunResults(results: RunResults, coverageEnabled: boolean): void {
  Object.assign(results.counter, newCounter());
  results.failedFiles.clear();
  results.failedTests.length = 0;
  results.coverage = coverageEnabled ? new Map() : null;
}
