import { Stream, type Channel } from '../stream/index.ts';
import type { Config } from '../types.ts';
import type {
  BrowserLog,
  Notice,
  Reporter,
  ReporterContext,
  RunStartInfo,
  TestDetails,
} from '../reporters/types.ts';
// Type-only, so the edge back to `run.ts` is erased: `run.ts` imports `APIReporter` at RUNTIME
// (`buildResult` reads it off the config), and a value-level cycle between the two would be real.
import type { RunResult, TestResult } from './run.ts';

/**
 * How many page-log entries a result retains. Tests and notices are bounded by the suite; page
 * output is bounded by nothing a test runner controls, so this is the one channel that needs a
 * ceiling. Generous enough that a real run never reaches it.
 *
 * ```ts
 * MAX_BROWSER_LOGS; // 1000
 * ```
 */
export const MAX_BROWSER_LOGS = 1000;

/**
 * The reporter that turns a run into a value: it records what happened instead of printing it.
 *
 * Attached by the JS API to every run, alongside whatever reporters the caller asked for — so
 * `reporter: 'tap'` still streams TAP *and* still resolves with a full {@link RunResult}.
 *
 * ```ts
 * import type { ReporterContext } from '../reporters/types.ts';
 *
 * const reporter = new APIReporter();
 * reporter.onTestEnd({} as ReporterContext, { status: 'passed', fullName: ['Math', 'adds'], runtime: 2 });
 * reporter.tests[0].fullName; // 'Math: adds'
 * ```
 */
export class APIReporter implements Reporter {
  /** Every finished test, in arrival order. */
  readonly tests: TestResult[] = [];
  /** Every diagnostic, in emission order. */
  readonly notices: Notice[] = [];
  /** The most recent page console calls and uncaught errors, capped at {@link MAX_BROWSER_LOGS}. */
  readonly browserLogs: BrowserLog[] = [];
  /** How many page-log entries the cap dropped. */
  browserLogsTruncated = 0;

  /**
   * Drops everything from a previous run. Watch sessions reuse one collector across reruns, so
   * this is what keeps rerun N's result from containing rerun N-1's tests.
   *
   * ```ts
   * const reporter = new APIReporter();
   * reporter.notices.push({ level: 'info', message: 'stale' });
   * reporter.reset();
   * reporter.notices.length; // 0
   * ```
   */
  reset(): void {
    this.tests.length = 0;
    this.notices.length = 0;
    this.browserLogs.length = 0;
    this.browserLogsTruncated = 0;
  }

  /**
   * Records one finished test.
   *
   * ```ts
   * import type { ReporterContext } from '../reporters/types.ts';
   *
   * const reporter = new APIReporter();
   * reporter.onTestEnd({} as ReporterContext, { status: 'failed', fullName: ['Cart', 'adds'], runtime: 4 });
   * reporter.tests[0].status; // 'failed'
   * ```
   */
  onTestEnd(_context: ReporterContext, details: TestDetails): void {
    this.tests.push(toTestResult(details));
  }

  /**
   * Records one diagnostic.
   *
   * ```ts
   * import type { ReporterContext } from '../reporters/types.ts';
   *
   * const reporter = new APIReporter();
   * reporter.onNotice({} as ReporterContext, { level: 'warning', message: 'No tests matched' });
   * reporter.notices[0].level; // 'warning'
   * ```
   */
  onNotice(_context: ReporterContext, notice: Notice): void {
    this.notices.push(notice);
  }

  /**
   * Records one page console call or uncaught error.
   *
   * ```ts
   * import type { ReporterContext } from '../reporters/types.ts';
   *
   * const reporter = new APIReporter();
   * reporter.onBrowserLog({} as ReporterContext, { type: 'error', text: 'boom', args: [] });
   * reporter.browserLogs[0].text; // 'boom'
   * ```
   */
  onBrowserLog(_context: ReporterContext, log: BrowserLog): void {
    this.browserLogs.push(log);
    // Drop from the front: a flood's newest lines are the ones next to whatever went wrong.
    if (this.browserLogs.length > MAX_BROWSER_LOGS) {
      this.browserLogs.shift();
      this.browserLogsTruncated++;
    }
  }
}

/**
 * The {@link APIReporter} watching this run — the reporter every result is built from.
 *
 * A run assembled by anything other than the JS API has none, and an empty one answers that
 * honestly: no collector, nothing collected.
 *
 * ```ts
 * import type { Config } from '../types.ts';
 *
 * // Defined, not invoked: reads the live reporter list off a resolved Config.
 * function tests(config: Config) {
 *   return findAPIReporterFrom(config).tests;
 * }
 * ```
 */
export function findAPIReporterFrom(config: Config): APIReporter {
  return config.state.reporters.find((one) => one instanceof APIReporter) ?? new APIReporter();
}

/**
 * Projects one QUnit `testEnd` payload into a {@link TestResult}. QUnit's `fullName` is
 * `[...modules, testName]`; the joined display form matches what `filter` matches against —
 * modules separated by ` > `, the test name after a `: `.
 *
 * ```ts
 * toTestResult({ status: 'passed', fullName: ['Cart', 'adds item'], runtime: 2 }).fullName;
 * // 'Cart: adds item'
 * ```
 */
export function toTestResult(details: TestDetails): TestResult {
  const modules = details.fullName.slice(0, -1);
  const name = details.fullName[details.fullName.length - 1] ?? '';

  return {
    name,
    modules,
    fullName: modules.length > 0 ? `${modules.join(' > ')}: ${name}` : name,
    status: details.status as TestResult['status'],
    durationMs: details.runtime,
    assertions: details.assertions ?? [],
    // Filled in by `buildResult`, which is where the failure attribution is available.
    file: null,
  };
}

/**
 * One thing that happened during a run, as it happened.
 *
 * The fine-grained view of what {@link RunResult} summarizes. A caller that only wants the answer
 * awaits the result; a caller drawing a progress bar reads these. Discriminated on `kind` so a
 * `switch` is exhaustive and adding a variant is a compile error at every consumer rather than a
 * silently-ignored event.
 *
 * The last event of every run is `runEnd`, and it carries the complete result — so a consumer
 * reading only this feed never needs a second channel to learn how the run came out.
 *
 * ```ts
 * // Defined, not invoked: real events arrive from a session.
 * function label(event: RunEvent) {
 *   return event.kind === 'test' ? event.test.fullName : event.kind;
 * }
 * ```
 */
export type RunEvent =
  | ({ kind: 'runStart' } & RunStartInfo)
  | { kind: 'test'; test: TestResult }
  | { kind: 'notice'; notice: Notice }
  | { kind: 'browserLog'; log: BrowserLog }
  | { kind: 'runEnd'; result: RunResult };

/**
 * The buffer a feed keeps for a consumer that has stopped reading.
 *
 * Generous enough that no real suite reaches it: tests and notices are bounded by the suite, and
 * the only unbounded channel is page output — the same flood `MAX_BROWSER_LOGS` exists for.
 * Past it the oldest events go, matching the page-log cap for the same reason: under a flood the
 * newest are the ones adjacent to whatever went wrong.
 *
 * ```ts
 * CHANNEL_CAPACITY; // 10000
 * ```
 */
export const CHANNEL_CAPACITY = 10_000;

/**
 * A channel carrying one run's events, together with the {@link Reporter} that fills it.
 *
 * The two are one thing in practice — every caller attaches `reporter` to the run and reads
 * `stream` — so they are handed over together rather than paired up at each call site.
 */
export type EventsChannel = Channel<RunEvent> & { readonly reporter: Reporter };

/**
 * Opens an {@link EventsChannel}: capped, drop-oldest, and lazy when given `onDemand`.
 *
 * The two options are the policy — everything else a feed needs (the buffer, the parked-consumer
 * slot, the dropped counter) is {@link Stream.channel}'s.
 *
 * ```ts
 * import type { ReporterContext } from '../reporters/types.ts';
 *
 * const channel = EventsChannel.build();
 * channel.reporter.onNotice?.({} as ReporterContext, { level: 'info', message: 'scoped' });
 * channel.buffered; // 1 — held for whoever consumes it
 * ```
 */
function build(options: { onDemand?: () => void } = {}): EventsChannel {
  const channel = Stream.channel<RunEvent>({
    capacity: CHANNEL_CAPACITY,
    overflow: 'dropOldest',
    ...options,
  });

  // Assigned onto the channel rather than spread into a new object: `buffered`, `dropped` and
  // `closed` are getters, and a spread would freeze them at their construction-time values.
  return Object.assign(channel, { reporter: buildReporter(channel) });
}

/**
 * Reshapes the five reporter callbacks into one ordered stream of {@link RunEvent}s.
 *
 * `runEnd` is not emitted here: only the session knows how to assemble the result that event
 * carries, and it pushes that itself once the recorder has been read. Reached through
 * {@link EventsChannel.build}, which is the only way the two are ever used.
 */
function buildReporter(channel: Channel<RunEvent>): Reporter {
  return {
    onRunStart: (_context: ReporterContext, info: RunStartInfo) =>
      channel.emit({ kind: 'runStart', ...info }),
    onTestEnd: (_context: ReporterContext, details: TestDetails) =>
      channel.emit({ kind: 'test', test: toTestResult(details) }),
    onNotice: (_context: ReporterContext, notice: Notice) =>
      channel.emit({ kind: 'notice', notice }),
    onBrowserLog: (_context: ReporterContext, log: BrowserLog) =>
      channel.emit({ kind: 'browserLog', log }),
  };
}

/**
 * The run's event feed: `build()` opens one, `buildReporter()` is the adapter inside it.
 *
 * A namespace rather than two loose exports, so a call site says which subject it is reaching
 * for — `EventsChannel.build()` next to `APIReporter`, the other half of this module.
 *
 * ```ts
 * EventsChannel.build().buffered; // 0 — nothing emitted yet
 * ```
 */
export const EventsChannel = { build, buildReporter };
