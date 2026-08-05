import type { BuildState, Counter, GroupState, RunResults, RunState } from '../types.ts';
import type { QUnitSelector } from '../selection/line-targets.ts';
import type { Page } from 'playwright-core';
import { processOutput } from '../reporters/output.ts';

/**
 * The daemon's reusable Page slot, or `null` when reuse does not apply.
 *
 * Reuse is single-group only. In concurrent group mode group 0 would otherwise drain
 * `slot.page` (Browser.setup consumes it) without re-stashing it, leaving the slot empty for the
 * next single-file run — so a transient multi-file invocation would cost the following run a
 * fresh `newPage()`. Withholding the slot here keeps the warm page untouched instead.
 *
 * Both consumers — the drain in `Browser.setup` and the re-stash in `run()` — go through this,
 * so the rule lives in one place rather than in two guards that must agree.
 *
 * ```ts
 * import * as RunState from './run-state.ts';
 *
 * const state = RunState.create();
 * RunState.reusablePageSlot(state); // null — not a daemon run, nothing to reuse
 * RunState.reusablePageSlot({ ...state, groupCount: 3 }); // null — withheld in concurrent group mode
 * ```
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
 *
 * ```ts
 * import * as RunState from './run-state.ts';
 *
 * const group = RunState.newGroup(2);
 * group.index; // 2
 * group.phase; // 'bundling'
 * ```
 */
export function newGroup(index = 0, selectors?: QUnitSelector[]): GroupState {
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
    lastRanFiles: null,
    testEndCounts: new Map(),
    wsConnectionCount: 0,
    lastQUnitResult: null,
    pendingConsoleHandlers: null,
    sourceMapDecoder: null,
    build: {
      allTestCode: null,
      htmlPathsToRunTests: [],
      lastBuildErrored: false,
    },
  };
}

/**
 * Fresh run state for a single `qunitx` invocation. Built once per run in `Config.setup()`.
 *
 * ```ts
 * import * as RunState from './run-state.ts';
 *
 * const state = RunState.create();
 * state.groupCount; // 1
 * state.results.counter.testCount; // 0
 * ```
 */
export function create(): RunState {
  return {
    daemon: null,
    group: newGroup(),
    groupCount: 1,
    aborters: new Set(),
    reporters: [],
    output: processOutput,
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
      builtContentHash: {},
      justAddedAt: new Map(),
    },
    results: {
      counter: newCounter(),
      failedFiles: new Set(),
      failedTests: [],
      coverage: null,
      aborted: false,
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
 *
 * ```ts
 * import * as RunState from './run-state.ts';
 *
 * const { results } = RunState.create();
 * results.counter.failCount = 3;
 * results.failedFiles.add('/proj/test/cart-test.ts');
 * RunState.reset(results, false);
 * [results.counter.failCount, results.failedFiles.size]; // [0, 0] — same objects, cleared in place
 * ```
 */
export function reset(results: RunResults, coverageEnabled: boolean): void {
  Object.assign(results.counter, newCounter());
  results.failedFiles.clear();
  results.failedTests.length = 0;
  results.coverage = coverageEnabled ? new Map() : null;
  results.aborted = false;
}

/**
 * Asks every live server to tell its pages to drop the rest of the QUnit queue, and records that
 * this run was cut short.
 *
 * The flag is set on intent, not on the browser's acknowledgement, and that is deliberate: an
 * abort that arrives before any page has connected — a `signal` already aborted, a `qq` during
 * start-up — would otherwise reach nobody and go unrecorded. `WebServer.setup` re-sends it to
 * pages that connect afterwards, so the request survives the gap either way.
 *
 * Cleared by {@link reset} at the start of every run, so an abort while idle does not follow the
 * session into its next run.
 *
 * ```ts
 * import * as RunState from './run-state.ts';
 *
 * const state = RunState.create();
 * RunState.requestAbort(state);
 * state.results.aborted; // true — even with no server listening yet
 * ```
 */
export function requestAbort(state: RunState): void {
  state.results.aborted = true;
  state.aborters.forEach((stop) => stop());
}

/**
 * Invalidates a group's compiled bundles so the next run rebuilds them from disk.
 *
 * Both go together: `/tests.js` serves `allTestCode` and `/filtered-tests.js` serves
 * `filteredTestCode` verbatim, so clearing only the full bundle leaves a stale filtered one
 * servable — and a watch-mode delete would then rerun tests from a file that no longer exists.
 *
 * ```ts
 * import * as RunState from './run-state.ts';
 *
 * const { build } = RunState.newGroup();
 * build.allTestCode = 'bundled js…';
 * RunState.clearBundles(build);
 * build.allTestCode; // null — the next run rebuilds both bundles from disk
 * ```
 */
export function clearBundles(build: BuildState): void {
  build.allTestCode = null;
  build.filteredTestCode = undefined;
}
