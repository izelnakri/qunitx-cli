import { toTestResult, type RunResult, type TestResult } from './result.ts';
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
 * How many events a feed buffers for a consumer that has stopped reading.
 *
 * Generous enough that no real suite reaches it: tests and notices are bounded by the suite, and
 * the only unbounded channel is page output — the same flood `MAX_BROWSER_LOGS` exists for.
 *
 * ```ts
 * MAX_BUFFERED_EVENTS; // 10000
 * ```
 */
export const MAX_BUFFERED_EVENTS = 10_000;

/**
 * A one-consumer async queue: the producer pushes whenever it likes, the consumer iterates.
 *
 * The shape every push-source in this API needs, because the producer is a browser and cannot be
 * slowed down. Backpressure is therefore not on offer: the choice is buffer or drop, and this
 * buffers up to {@link MAX_BUFFERED_EVENTS} before dropping the oldest — the same trade, for the
 * same reason, as the page-log cap on a result. Both sessions keep the buffer near zero in
 * practice by not starting the run until someone is actually consuming.
 *
 * One consumer. Two concurrent `for await` loops would each take half the events rather than both
 * seeing all of them; fan out inside the single loop instead.
 *
 * ```ts
 * const channel = new Channel<number>();
 * channel.push(1);
 * channel.close();
 * channel.buffered; // 1 — waiting for whoever iterates
 * ```
 */
export class Channel<T> implements AsyncIterable<T> {
  /** How many pushes were dropped to stay under the cap. `0` in every ordinary run. */
  dropped = 0;
  #queued: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | null = null;
  #closed = false;

  /**
   * How many values are buffered for a consumer that has not asked for them yet.
   *
   * ```ts
   * const channel = new Channel<number>();
   * channel.push(1);
   * channel.buffered; // 1
   * ```
   */
  get buffered(): number {
    return this.#queued.length;
  }

  /**
   * Whether {@link close} has been called.
   *
   * ```ts
   * const channel = new Channel<number>();
   * channel.closed; // false — still accepting pushes
   * ```
   */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Hands a value to whoever is iterating, or buffers it until someone is. Silently ignored once
   * closed — a late event from a run being torn down is not worth a throw at the producer, which
   * is a browser callback with nowhere to report it.
   *
   * ```ts
   * const channel = new Channel<string>();
   * channel.push('a');
   * channel.buffered; // 1
   * ```
   */
  push(value: T): void {
    if (this.#closed) return;
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = null;

      return resolve({ done: false, value });
    }

    this.#queued.push(value);
    // Oldest first, matching the page-log cap: under a flood the newest entries are the ones
    // adjacent to whatever went wrong, and they are what a consumer catching up wants to see.
    if (this.#queued.length > MAX_BUFFERED_EVENTS) {
      this.#queued.shift();
      this.dropped++;
    }
  }

  /**
   * Ends the iteration once the buffer drains. Idempotent.
   *
   * ```ts
   * const channel = new Channel<string>();
   * channel.close();
   * channel.closed; // true
   * ```
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Wake a consumer parked on a value that is never going to arrive.
    this.#waiting?.({ done: true, value: undefined });
    this.#waiting = null;
  }

  /**
   * ```ts
   * // Defined, not invoked: iterating a live channel waits for its producer.
   * async function drain(channel: Channel<number>) {
   *   const seen: number[] = [];
   *   for await (const value of channel) seen.push(value);
   *   return seen;
   * }
   * ```
   */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        // Buffer first, even when closed: values that arrived before the close are still values,
        // and dropping them would make closing racy from the consumer's side.
        if (this.#queued.length > 0) {
          return Promise.resolve({ done: false, value: this.#queued.shift() as T });
        } else if (this.#closed) {
          return Promise.resolve({ done: true, value: undefined });
        }

        return new Promise((resolve) => (this.#waiting = resolve));
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();

        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
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
 * const channel = new Channel<RunEvent>();
 * const reporter = eventReporter(channel);
 * reporter.onNotice?.({} as Config, { level: 'info', message: 'scoped to 2 files' });
 * channel.buffered; // 1
 * ```
 */
export function eventReporter(channel: Channel<RunEvent>): Reporter {
  return {
    onRunStart: (_config: Config, info: RunStartInfo) =>
      channel.push({ kind: 'runStart', ...info }),
    onTestEnd: (_config: Config, details: TestDetails) =>
      channel.push({ kind: 'test', test: toTestResult(details) }),
    onNotice: (_config: Config, notice: Notice) => channel.push({ kind: 'notice', notice }),
    onBrowserLog: (_config: Config, log: BrowserLog) => channel.push({ kind: 'browserLog', log }),
  };
}
