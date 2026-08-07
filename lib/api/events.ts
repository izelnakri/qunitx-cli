import { toTestResult, type RunResult, type TestResult } from './result.ts';
import { Stream, type Channel } from '../stream/index.ts';
import type {
  BrowserLog,
  Notice,
  Reporter,
  RunStartInfo,
  TestDetails,
} from '../reporters/types.ts';
import type { Config } from '../types.ts';

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
 * FEED_CAPACITY; // 10000
 * ```
 */
export const FEED_CAPACITY = 10_000;

/**
 * Opens a channel for one run's events.
 *
 * This used to be ninety lines of hand-rolled queue in this file — a buffer, a parked-consumer
 * slot, a drop-oldest cap and a dropped counter. `Stream.channel` is that, generalised, and it
 * arrives with three things the local copy never had: `ready()` for a producer that CAN slow
 * down, `fail()` to put a declared failure on the railway rather than in a notice, and
 * `onDemand`, which is exactly the lazy-start rule `runSession` used to implement by hand.
 *
 * ```ts
 * const feed = openFeed();
 * feed.emit({ kind: 'notice', notice: { level: 'info', message: 'scoped to 2 files' } });
 * feed.buffered; // 1 — held for whoever consumes it
 * ```
 */
export function openFeed(options: { onDemand?: () => void } = {}): Channel<RunEvent> {
  return Stream.channel<RunEvent>({
    capacity: FEED_CAPACITY,
    overflow: 'dropOldest',
    ...options,
  });
}

/**
 * A reporter that turns the run into {@link RunEvent}s on `channel`.
 *
 * The reporter contract is already the live feed — this only reshapes its five callbacks into one
 * ordered stream. `runEnd` is not emitted here: only the session knows how to assemble the result
 * that event carries, and it pushes that itself once the collector has been read.
 *
 * ```ts
 * import type { Config } from '../types.ts';
 *
 * const channel = openFeed();
 * const reporter = eventReporter(channel);
 * reporter.onNotice?.({} as Config, { level: 'info', message: 'scoped to 2 files' });
 * channel.buffered; // 1
 * ```
 */
export function eventReporter(channel: Channel<RunEvent>): Reporter {
  return {
    onRunStart: (_config: Config, info: RunStartInfo) =>
      channel.emit({ kind: 'runStart', ...info }),
    onTestEnd: (_config: Config, details: TestDetails) =>
      channel.emit({ kind: 'test', test: toTestResult(details) }),
    onNotice: (_config: Config, notice: Notice) => channel.emit({ kind: 'notice', notice }),
    onBrowserLog: (_config: Config, log: BrowserLog) => channel.emit({ kind: 'browserLog', log }),
  };
}
