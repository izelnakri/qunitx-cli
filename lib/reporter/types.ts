import type { Config, Counter } from '../types.ts';

/**
 * Every stdout reporter `--reporter` accepts, in help/error-message order. Exactly one is
 * active per run — artifact outputs (`--junit`, `--coverage`) are separate additive flags.
 * This module is a leaf (type-only imports), so `parse-cli-flags` can validate against it
 * without pulling the reporter implementations into the CLI's startup path.
 */
export const REPORTERS = ['tap', 'spec', 'dot', 'github'] as const;

/** A valid `--reporter` value. */
export type ReporterName = (typeof REPORTERS)[number];

/**
 * The internal reporter contract. Reporters render a run to stdout (or to a file, for
 * additive artifact reporters like JUnit). This is deliberately **not** public API — it is
 * not exported from the package entry point and carries no stability promise. Custom
 * reporters are expected to arrive later via the JS API's event stream, not by freezing
 * QUnit's `testEnd` payload as third-party surface.
 *
 * Lifecycle: `onRunStart` → `onTestEnd` (× N) → `onRunEnd`. In watch mode the whole cycle
 * repeats per rerun, so stateful reporters must reset in `onRunStart`.
 *
 * Concurrency: one reporter instance is shared across all concurrent groups (the group
 * configs are spread off the parent config, so `_reporters` is the same array). `onTestEnd`
 * therefore arrives interleaved across groups.
 */
export interface Reporter {
  /** Called once before any test output. In watch mode, once per rerun. */
  onRunStart?(config: Config, info: RunStartInfo): void;
  /** Called once per test, after `counter` has already been updated for this test. */
  onTestEnd?(config: Config, details: TestDetails): void;
  /** Called once when the run finishes, with the final counts on `config.state.results.counter`. */
  onRunEnd?(config: Config, info: RunEndInfo): void | Promise<void>;
}

/** One QUnit assertion inside a `testEnd` payload. */
export interface TestAssertion {
  /** `true` when the assertion held. */
  passed: boolean;
  /** `true` for assertions inside a `todo` test, which are expected to fail. */
  todo: boolean;
  /** Raw stack captured at the assertion, with frames pointing at the bundle. */
  stack?: string;
  /** The value the assertion actually saw. */
  actual?: unknown;
  /** The value the assertion required. */
  expected?: unknown;
  /** The assertion's message, when one was given. */
  message?: string;
}

/**
 * The QUnit `testEnd` payload as it arrives over the WebSocket. Passing tests carry the
 * trimmed `{ status, fullName, runtime }`; failing tests additionally carry `assertions`.
 */
export interface TestDetails {
  /** QUnit's outcome: `passed` | `failed` | `skipped` | `todo`. */
  status: string;
  /** Module path followed by the test name, e.g. `['Math', 'adds']`. */
  fullName: string[];
  /** Test duration in milliseconds. */
  runtime: number;
  /** Present on failing tests only (QUnit trims the payload otherwise). */
  assertions?: TestAssertion[];
}

/**
 * Run-scope counts. `fileCount === null` means "counts unknown at this point" (watch mode,
 * where the header is emitted per browser connection rather than per file batch).
 */
export interface RunStartInfo {
  /** Test files in this run, or `null` when not known at announce time. */
  fileCount: number | null;
  /** Concurrent groups the files were split across, or `null` alongside a null `fileCount`. */
  groupCount: number | null;
}

/** Final run info; the counts themselves live on `config.state.results.counter`. */
export interface RunEndInfo {
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
}

/**
 * Applies one `testEnd` to the run's counters. Kept separate from any reporter so the
 * numbers are identical no matter which reporter (or how many) is active — the exit code
 * and the TAP plan both read `counter`, so it must be updated exactly once per test.
 */
export function updateCounter(counter: Counter, details: TestDetails): void {
  counter.testCount++;

  if (details.status === 'skipped') {
    counter.skipCount++;
  } else if (details.status === 'todo') {
    counter.todoCount = (counter.todoCount ?? 0) + 1;
  } else if (details.status === 'failed') {
    counter.failCount++;
    (details.assertions ?? []).forEach((assertion) => {
      if (!assertion.passed && assertion.todo === false) {
        counter.errorCount = (counter.errorCount ?? 0) + 1;
      }
    });
  } else if (details.status === 'passed') {
    counter.passCount++;
  }
}
