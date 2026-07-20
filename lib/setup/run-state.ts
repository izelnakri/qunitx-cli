import type { Counter, GroupState, RunResults, RunState } from '../types.ts';
import type { QUnitSelector } from '../selection/line-targets.ts';
import type { Page } from 'playwright-core';

/**
 * The daemon's reusable Page slot, or `null` when reuse does not apply.
 *
 * Reuse is single-group only. In concurrent group mode group 0 would otherwise drain
 * `slot.page` (setupBrowser consumes it) without re-stashing it, leaving the slot empty for the
 * next single-file run — so a transient multi-file invocation would cost the following run a
 * fresh `newPage()`. Withholding the slot here keeps the warm page untouched instead.
 *
 * Both consumers — the drain in `setupBrowser` and the re-stash in `run()` — go through this,
 * so the rule lives in one place rather than in two guards that must agree.
 */
export function reusablePageSlot(state: RunState): { page: Page | null } | null {
  return state.groupCount === 1 ? (state.daemon?.pageSlot ?? null) : null;
}

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

/**
 * Fresh per-group state. One per concurrent group; the group spread in `runConcurrentMode`
 * replaces `state.group` with this so groups never share the slots inside it.
 */
export function newGroupState(index = 0, selectors?: QUnitSelector[]): GroupState {
  return {
    index,
    groupMode: false,
    signals: {
      testRunDone: null,
      resetTestTimeout: null,
      onWsOpen: null,
      onTestsJsServed: null,
    },
    phase: 'bundling',
    selectors,
    ranFiles: null,
    lastFailedFiles: null,
    testEndCounts: new Map(),
    wsConnectionCount: 0,
    lastQUnitResult: null,
    pendingConsoleHandlers: null,
    sourceMapDecoder: null,
  };
}

/** Fresh run state for a single `qunitx` invocation. Built once per run in `setupConfig()`. */
export function newRunState(): RunState {
  return {
    daemon: null,
    group: newGroupState(),
    groupCount: 1,
    reporters: [],
    htmlAssets: {
      assets: new Set(),
      mainHTML: { filePath: null, html: null },
      staticHTMLs: {},
      dynamicContentHTMLs: {},
    },
    watch: {
      building: false,
      pendingBuildTrigger: null,
      justAddedFiles: new Set(),
      lastBuildEndMs: 0,
      lastBuildErrored: false,
      builtContentHash: {},
      justAddedAt: new Map(),
    },
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
