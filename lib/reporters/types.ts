import type { Counter } from '../types.ts';
import type { Console } from '../console.ts';
import type { SourceMapDecoder } from '../utils/source-map.ts';

/**
 * Every stdout reporter `--reporter` accepts, in help/error-message order. Exactly one is
 * active per run — artifact outputs (`--junit`, `--coverage`) are separate additive flags.
 * This module is a leaf (type-only imports), so `Args.parse` can validate against it
 * without pulling the reporter implementations into the CLI's startup path.
 *
 * ```ts
 * REPORTERS[0]; // 'tap' — the default
 * REPORTERS.join(', '); // 'tap, spec, dot, github' — the order help and errors list them in
 * ```
 */
export const REPORTERS = ['tap', 'spec', 'dot', 'github'] as const;

/**
 * A valid `--reporter` value.
 *
 * ```ts
 * const name: ReporterName = 'dot';
 * name; // 'dot' — anything outside REPORTERS is a type error
 * ```
 */
export type ReporterName = (typeof REPORTERS)[number];

/**
 * What a reporter is given on every hook: where to write, what the run has counted so far, and
 * the few resolved paths a message needs.
 *
 * Deliberately not the run's `Config`. A reporter is third-party code, and handing it the whole
 * config would hand it the mutable state of the run it is reporting on — plus a type it cannot
 * name, since `Config` is internal. Everything here is read-only from a reporter's side.
 *
 * `counts` and `sourceMapDecoder` are live: `counts` is the same object the runner mutates, and
 * the decoder arrives partway through a run, so both read through rather than being snapshots.
 *
 * ```ts
 * // Defined, not invoked: a reporter that prints a running tally.
 * const tally = {
 *   onTestEnd({ console, counts }: ReporterContext) {
 *     console.log(`# ${counts.passed}/${counts.total}\n`);
 *   },
 * };
 * tally.onTestEnd.length; // 1 — the context is the only thing a simple reporter needs
 * ```
 */
export interface ReporterContext {
  /** Where this reporter's text goes. `silentConsole` when the run was asked to print nothing. */
  console: Console;
  /** The run's live outcome totals — the same object the runner updates, not a copy. */
  counts: Counter;
  /** Absolute path of the directory holding `package.json`, for rendering paths relative to it. */
  projectRoot: string;
  /** Absolute path of the build output directory. */
  output: string;
  /** `--junit`'s value: `true` for the default path, a string for an explicit one. */
  junit?: boolean | string;
  /** Maps a bundle stack frame back to source, once the run has built one. */
  sourceMapDecoder: SourceMapDecoder | null;
  /** Whether this run is executing inside the persistent daemon. */
  daemon: boolean;
}

/**
 * The reporter contract — the public extension point for observing a run. Reporters render it
 * to text (the built-in `tap`/`spec`/`dot`/`github`), write an artifact (`junit`), or simply
 * collect, which is how the JS API turns a run into a value.
 *
 * Every method is optional, so a reporter is any object carrying the handlers it cares about.
 *
 * Lifecycle: `onRunStart` → (`onTestEnd` | `onNotice` | `onBrowserLog`)* → `onRunEnd`. In watch
 * mode the whole cycle repeats per rerun, so stateful reporters must reset in `onRunStart`.
 *
 * Concurrency: one reporter instance is shared across all concurrent groups (the group
 * configs are spread off the parent config, so `state.reporters` is the same array). `onTestEnd`
 * therefore arrives interleaved across groups.
 *
 * Text goes through `context.console`, never `process.stdout` — that indirection is what lets a
 * caller redirect or silence a built-in reporter.
 *
 * ```ts
 * const names: string[] = [];
 * const reporter: Reporter = {
 *   onTestEnd(_context, details) {
 *     names.push(details.fullName.join(' | ')); // one entry per finished test
 *   },
 * };
 * reporter.onTestEnd?.({} as ReporterContext, { status: 'passed', fullName: ['Math', 'adds'], runtime: 2 });
 * names; // ['Math | adds']
 * ```
 */
export interface Reporter {
  /** Called once before any test output. In watch mode, once per rerun. */
  onRunStart?(context: ReporterContext, info: RunStartInfo): void;
  /** Called once per test, after `counter` has already been updated for this test. */
  onTestEnd?(context: ReporterContext, details: TestDetails): void;
  /** Called once when the run finishes, with the final counts on `config.state.results.counter`. */
  onRunEnd?(context: ReporterContext, info: RunEndInfo): void | Promise<void>;
  /**
   * Called for each of qunitx's own diagnostics — the `# …` lines about what it decided to run,
   * what it could not find, what timed out. The default rendering has already gone to
   * `config.state.console`; implement this only to capture them as data.
   */
  onNotice?(context: ReporterContext, notice: Notice): void;
  /**
   * Called for each `console.*` call and uncaught error from the page under test. Only warnings
   * and errors arrive unless `debug` is on — the same selection the CLI prints.
   */
  onBrowserLog?(context: ReporterContext, log: BrowserLog): void;
}

/**
 * One diagnostic from qunitx itself: which files a narrowing flag scoped the run to, a filter
 * that matched nothing, a build error, a timeout.
 *
 * Distinct from a test result, and distinct from the program failing — a notice is qunitx
 * explaining what it did. The CLI renders these as TAP `#` comments, which is what they have
 * always been; a programmatic caller reads them as a list.
 *
 * ```ts
 * const notice: Notice = { level: 'warning', message: 'No tests matched --filter "Crat"' };
 * notice.level; // 'warning' — an 'error' additionally goes to the error stream
 * ```
 */
export interface Notice {
  /** `info` is a decision, `warning` a surprise, `error` a diagnostic that also hits stderr. */
  level: 'info' | 'warning' | 'error';
  /** The text, already colored where the CLI colors it, with no `#` prefix and no newline. */
  message: string;
  /**
   * Write `message` verbatim rather than as a `# `-prefixed comment. For pre-formatted blocks —
   * the coverage table, a stack trace — whose own layout is the point.
   */
  raw?: boolean;
  /**
   * Which of the run's two streams the default rendering goes to; `output` by default.
   *
   * Separate from `level` because the two answer different questions: `level` is what kind of
   * thing this is, which is what a consumer filters on, while this is where the CLI has always
   * put it. A raw stack belongs on `error` alone — un-prefixed multi-line text on stdout would
   * corrupt the TAP document — and a few diagnostics go to `both` deliberately, so a reader
   * watching only one stream still sees them.
   */
  stream?: 'output' | 'error' | 'both';
}

/**
 * A `console.*` call or an uncaught error from the page under test.
 *
 * ```ts
 * const log: BrowserLog = { type: 'error', text: 'TypeError: x is not a function', args: [] };
 * log.type; // 'error' — 'pageerror' marks an uncaught exception rather than a console call
 * ```
 */
export interface BrowserLog {
  /** The page console type (`log`/`warning`/`error`/`info`/`debug`), or `pageerror`. */
  type: string;
  /** The rendered single-line text. Always present. */
  text: string;
  /** The call's arguments, resolved to JSON values where the page could serialize them. */
  args: unknown[];
}

/**
 * One QUnit assertion inside a `testEnd` payload.
 *
 * ```ts
 * const assertion: TestAssertion = { passed: false, todo: false, actual: 3, expected: 4 };
 * assertion.passed; // false — this assertion is what failed its test
 * ```
 */
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
 *
 * ```ts
 * const details: TestDetails = { status: 'passed', fullName: ['Math', 'adds'], runtime: 2 };
 * details.fullName.join(' | '); // 'Math | adds' — the display name reporters print
 * ```
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
 *
 * ```ts
 * const batch: RunStartInfo = { fileCount: 3, groupCount: 2 }; // "3 test files across 2 groups"
 * const watch: RunStartInfo = { fileCount: null, groupCount: null }; // counts unknown
 * batch.fileCount; // 3
 * watch.fileCount; // null
 * ```
 */
export interface RunStartInfo {
  /** Test files in this run, or `null` when not known at announce time. */
  fileCount: number | null;
  /** Concurrent groups the files were split across, or `null` alongside a null `fileCount`. */
  groupCount: number | null;
}

/**
 * Final run info; the counts themselves live on `config.state.results.counter`.
 *
 * ```ts
 * const info: RunEndInfo = { durationMs: 1240 };
 * info.durationMs; // what the summary prints as "(1240ms)"
 * ```
 */
export interface RunEndInfo {
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
}

/**
 * Applies one `testEnd` to the run's counters. Kept separate from any reporter so the
 * numbers are identical no matter which reporter (or how many) is active — the exit code
 * and the TAP plan both read `counter`, so it must be updated exactly once per test.
 *
 * ```ts
 * const counter = { total: 0, failed: 0, skipped: 0, todo: 0, passed: 0, assertionsFailed: 0 };
 * updateCounter(counter, { status: 'passed', fullName: ['Math', 'adds'], runtime: 2 });
 * counter.total; // 1
 * counter.passed; // 1
 * ```
 */
export function updateCounter(counter: Counter, details: TestDetails): void {
  counter.total++;

  if (details.status === 'skipped') {
    counter.skipped++;
  } else if (details.status === 'todo') {
    counter.todo = (counter.todo ?? 0) + 1;
  } else if (details.status === 'failed') {
    counter.failed++;
    (details.assertions ?? []).forEach((assertion) => {
      if (!assertion.passed && assertion.todo === false) {
        counter.assertionsFailed = (counter.assertionsFailed ?? 0) + 1;
      }
    });
  } else if (details.status === 'passed') {
    counter.passed++;
  }
}
