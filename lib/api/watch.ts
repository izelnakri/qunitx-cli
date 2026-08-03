import * as Config from '../setup/config.ts';
import * as Run from '../commands/run.ts';
import { Task } from '../task/index.ts';
import { unwrap } from '../result/result.ts';
import { buildResult, type Collector, type RunResult } from './result.ts';
import { normalizeOptions, resolveReporting, toConfigOptions, type RunOptions } from './options.ts';
import { junitXml, type RunFailure } from './run.ts';
import type { Reporter } from '../reporters/types.ts';
import type { Config as ResolvedConfig } from '../types.ts';

/** The reporter set plus the collector results are built from — what a session snapshots. */
interface Reporting {
  reporters: Reporter[];
  collector: Collector;
}

/**
 * A running watch session.
 *
 * Async-iterable, and that is the intended way to consume it: `for await (const result of
 * session)` yields the initial run and then one {@link RunResult} per rerun, in order, ending
 * when the session is closed. Every element is a complete result — counters, tests, diagnostics
 * — rather than a delta, so nothing has to be accumulated to know where the suite stands.
 *
 * One consumer at a time. Two concurrent `for await` loops would race for each result rather
 * than both seeing it; if you need to fan out, do it inside the one loop.
 *
 * ```ts
 * // Defined, not invoked: a real session holds a browser open.
 * async function untilGreen(session: WatchSession) {
 *   for await (const result of session) {
 *     if (result.ok) break; // breaking out closes the session
 *   }
 * }
 * ```
 */
export interface WatchSession extends AsyncIterable<RunResult> {
  /** Where the QUnit view is being served, e.g. `http://localhost:1234`. */
  readonly url: string;
  /** The initial run's result, available before anything has changed on disk. */
  readonly initial: RunResult;
  /** Re-runs now, optionally scoped to `files`, and resolves with that run's result. */
  rerun(files?: string[]): Promise<RunResult>;
  /** Stops watching, closes the browser and server, and ends the iteration. Idempotent. */
  close(): Promise<void>;
}

/**
 * Starts a watch session: builds once, runs once, then re-runs on every save until closed.
 *
 * Resolves as soon as that first run has finished and the watchers are armed, so there is no
 * window in which a save could be missed. The process then stays alive because the session holds
 * a browser and a bound port — `close()` is what releases both.
 *
 * Unlike the CLI's `--watch`, nothing is bound to stdin: no keyboard shortcuts are installed and
 * the host's terminal is left alone.
 *
 * ```ts
 * import { watch } from './watch.ts';
 *
 * // Defined, not invoked: launches a browser and leaves it watching.
 * async function watchCart() {
 *   const session = await watch({ inputs: ['test/'] });
 *   await session.close();
 *   return session.initial.counts.total;
 * }
 * ```
 */
export function watch(
  options: RunOptions | string | string[] = {},
): Task<WatchSession, RunFailure> {
  return Task(async () => {
    const resolved = normalizeOptions(options);
    const reporting = resolveReporting(resolved);
    const configOptions = toConfigOptions(resolved, reporting);
    const config = unwrap(await Config.setup({ ...configOptions, watch: true }).result());
    const inner = await Run.watch(config);

    // Snapshotted here, before the session installs its own rerun listener: the initial run has
    // already finished by the time `Run.watch` resolves, so it has no listener to fire and would
    // otherwise be the one result that never reaches the iterator.
    return new Session(inner, config, reporting, snapshot(config, reporting));
  });
}

/**
 * The live session. A class rather than an object literal because it owns a queue: reruns the
 * *file watcher* triggers have no caller to hand a result to, so they are buffered for whoever
 * is iterating — and a consumer that arrives late still sees every one of them.
 */
class Session implements WatchSession {
  readonly initial: RunResult;
  #inner: Run.WatchSession;
  #config: ResolvedConfig;
  #reporting: Reporting;
  #queued: RunResult[];
  #waiting: ((result: IteratorResult<RunResult>) => void) | null = null;
  #latest: RunResult;
  #published = 0;
  #closed = false;

  constructor(
    inner: Run.WatchSession,
    config: ResolvedConfig,
    reporting: Reporting,
    initial: RunResult,
  ) {
    this.#inner = inner;
    this.#config = config;
    this.#reporting = reporting;
    this.initial = initial;
    this.#latest = initial;
    // The initial run is the iteration's first element, so a `for await` sees the whole history
    // rather than starting from whatever happens to change next.
    this.#queued = [initial];
    // Every rerun goes through the same reporters, and `onRunEnd` is the last thing a run does —
    // which makes it the one honest signal that a result is complete and ready to snapshot.
    reporting.reporters.push({ onRunEnd: () => this.#publish() });
  }

  get url(): string {
    return this.#inner.url;
  }

  async rerun(files?: string[]): Promise<RunResult> {
    const before = this.#published;
    await this.#inner.rerun(files);
    // A rerun that died in the bundler never reaches `onRunEnd`, so nothing was published.
    // Snapshot it anyway: the build error is on the result as a notice, which is precisely what
    // the caller needs, and returning the *previous* run's result would be a lie.
    if (this.#published === before) this.#publish();

    return this.#latest;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#inner.close();
    // Wake a consumer parked on a rerun that is never going to come.
    this.#waiting?.({ done: true, value: undefined });
    this.#waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<RunResult> {
    return {
      next: (): Promise<IteratorResult<RunResult>> => {
        // Queue first, even when closed: results that arrived before shutdown are still results,
        // and dropping them would make `close()` racy from the consumer's point of view.
        const queued = this.#queued.shift();
        if (queued) return Promise.resolve({ done: false, value: queued });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });

        return new Promise((resolve) => (this.#waiting = resolve));
      },
      return: async (): Promise<IteratorResult<RunResult>> => {
        // `break` out of a for-await closes the session: leaving a browser running after the
        // loop that was reading it has stopped is never what was meant.
        await this.close();

        return { done: true, value: undefined };
      },
    };
  }

  /** Hands a finished run to whoever is iterating, or queues it until someone is. */
  #publish(): void {
    this.#published++;
    this.#latest = snapshot(this.#config, this.#reporting);
    if (!this.#waiting) return void this.#queued.push(this.#latest);

    const resolve = this.#waiting;
    this.#waiting = null;
    resolve({ done: false, value: this.#latest });
  }
}

/**
 * Freezes the run that just finished into a result, then clears the collector for the next one.
 *
 * The exit code is derived here rather than carried in: a watch rerun has no exit code, because
 * nothing exits — but "did this rerun pass" is exactly as meaningful, and is the same question
 * `failCount` answers for the batch runner.
 */
function snapshot(config: ResolvedConfig, reporting: Reporting): RunResult {
  const failed = config.state.results.counter.failCount > 0;
  const result = buildResult(
    config,
    { exitCode: failed ? 1 : 0, durationMs: 0 },
    reporting.collector,
    junitXml(reporting.reporters),
  );
  reporting.collector.reset();

  return result;
}
