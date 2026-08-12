import * as RunCommand from '../commands/run.ts';
import * as RunState from '../setup/run-state.ts';
import { Task } from '../task/index.ts';
import * as Run from './run.ts';
import { EventsChannel, type RunEvent } from './reporter.ts';

import * as Options from './options.ts';
import * as Config from '../setup/config.ts';
import type { Stream } from '../stream/index.ts';
import type { RunFailure, RunResult } from './run.ts';
import type { UserRunOptions } from './options.ts';
import type { Config as ResolvedConfig } from '../types.ts';

/**
 * One run, watched as it happens.
 *
 * Async-iterable over {@link RunEvent}: `runStart`, one `test` per finished test, `notice` and
 * `browserLog` as they arrive, and `runEnd` carrying the complete {@link RunResult}. The same
 * event shape a {@link WatchSession} produces, so a progress display written against one works
 * against the other.
 *
 * **The run does not start until you consume it.** Not an optimization — the correctness property
 * that makes the feed lossless. A browser cannot be told to slow down, so a run started before
 * anyone was reading would either drop events or buffer them all; starting on the first read means
 * the producer never outruns the consumer by more than one scheduling turn. Awaiting
 * {@link RunSession.result} counts as consuming, so a caller that only wants the answer still gets
 * one without iterating.
 *
 * ```ts
 * // Defined, not invoked: a real session launches a browser.
 * async function progress(session: RunSession) {
 *   for await (const event of session) {
 *     if (event.kind === 'test') process.stdout.write('.');
 *   }
 *   return (await session.result()).counts;
 * }
 * ```
 */
export interface RunSession extends AsyncIterable<RunEvent> {
  /**
   * The finished run. Starts it if nothing has yet, and resolves with the same
   * {@link RunResult} the final `runEnd` event carries — never `undefined`, which is the whole
   * reason this is a session rather than a bare event stream.
   *
   * Awaiting it twice is free: the second call returns the first's result.
   */
  result(): Promise<RunResult>;
  /**
   * Cuts the run short. The browser drops the rest of its queue and the run ends where it is,
   * with `aborted: true` on the result — which {@link RunSession.result} still resolves with, so
   * an aborted run is answered rather than left hanging.
   *
   * Resolves once the run has finished unwinding. Aborting before the run starts makes it a no-op
   * that ends the session immediately.
   */
  abort(): Promise<void>;
  /**
   * The same events as iterating the session, as a {@link Stream} — so the combinators are
   * there without a `Stream.from` wrapper.
   *
   * The session stays a HANDLE rather than becoming a Stream: every combinator returns a new
   * Stream, so `session.filter(…)` would hand back an object with no `close()` and a live
   * browser with no owner.
   *
   * ```ts
   * // Defined, not invoked: a real session launches a browser.
   * async function firstTen(session: RunSession) {
   *   return await session.events().filter((e) => e.kind === 'test').take(10).collect();
   * }
   * ```
   */
  events(): Stream<RunEvent>;
  /**
   * How many events the feed dropped because a consumer fell behind. `0` in every ordinary run.
   *
   * The feed is capped, so a consumer that stalls under a flood of page output loses the oldest
   * events. That has to be visible: {@link RunResult.browserLogsDropped} already keeps the
   * result path honest about the same trade, and a silent gap in the event path would be the one
   * kind of loss a consumer cannot detect for itself.
   */
  readonly droppedEvents: number;
  /** Closes the session, ending iteration. Idempotent; implied by `await using`. */
  close(): Promise<void>;
  /** Closes the session at the end of an `await using` block. */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Starts a single run you can watch happen, rather than one you wait out.
 *
 * Use it when the run's progress is the point — a progress bar, a live log, a UI that shows tests
 * as they finish. When only the outcome matters, `run()` is the smaller thing: it allocates none
 * of this machinery and hands back the same {@link RunResult}.
 *
 * Lazy twice over, and for two different reasons: the {@link Task} does nothing until awaited
 * (like every other verb here), and the session it resolves to does not start the run until it is
 * consumed (so the event feed cannot fall behind).
 *
 * ```ts
 * import { runSession } from './session.ts';
 *
 * // Defined, not invoked: launches a browser and runs the project's tests.
 * async function countAsTheyFinish() {
 *   await using session = await runSession({ inputs: ['test/'] });
 *   let finished = 0;
 *   for await (const event of session) if (event.kind === 'test') finished++;
 *   return finished;
 * }
 * ```
 */
export function runSession(
  options: UserRunOptions | string | string[] = {},
): Task<RunSession, RunFailure> {
  return Task(async () => {
    const channel = EventsChannel.build();
    const configOptions = Options.from(options);
    // Joins the reporters BEFORE assembly, not after: `Config.setup` emits notices of its own — a
    // superseded line target, `--only-failed` finding no cache — and a feed attached afterwards
    // would miss them while `result.notices` still carried them.
    configOptions.reporters.push(channel.reporter);
    // Assembly is eager: it reads package.json and resolves inputs, so a bad option is a failure
    // from `runSession(...)` itself rather than a surprise on first iteration. Only the browser
    // is deferred.
    const config = await Config.setup(configOptions);

    return new Session(config, channel, config.state.signal);
  });
}

/** The live session; a class because it owns the run's lifecycle and has to start it exactly once. */
class Session implements RunSession {
  #config: ResolvedConfig;
  #channel: EventsChannel;
  #started: Promise<RunResult> | null = null;
  #closed = false;

  constructor(config: ResolvedConfig, channel: EventsChannel, signal?: AbortSignal) {
    this.#config = config;
    this.#channel = channel;
    if (signal) {
      if (signal.aborted) this.#closed = true;
      else signal.addEventListener('abort', () => void this.abort(), { once: true });
    }
  }

  get droppedEvents(): number {
    return this.#channel.dropped;
  }

  result(): Promise<RunResult> {
    return this.#start();
  }

  async abort(): Promise<void> {
    // Nothing started means nothing to interrupt — and starting a run in order to stop it would
    // be an odd reading of `abort`. Close instead, so a consumer parked on the feed is released.
    if (!this.#started) {
      this.#closed = true;
      this.#channel.close();

      return;
    }

    RunState.requestAbort(this.#config.state);
    // Swallowed: the caller asked to stop, and a run that failed on the way down is not news they
    // asked for. `result()` still reports it to anyone who wants it.
    await this.#started.catch(() => {});
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // An in-flight run holds a browser, so closing has to stop it rather than walk away from it.
    if (this.#started) await this.abort();
    this.#channel.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  events(): Stream<RunEvent> {
    // The first read is what starts the run — same rule as iterating the session. `void` and no
    // `.catch` here on purpose: `#start` attaches the rejection handler itself (it also closes
    // the feed), so a second one at every call site would suppress nothing and imply the hazard
    // lives here rather than there.
    void this.#start();

    return this.#channel.stream;
  }

  [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
    // The first read is what starts the run — see the laziness note on `RunSession`.
    void this.#start();
    const inner = this.#channel.stream[Symbol.asyncIterator]();

    return {
      next: () => inner.next(),
      return: async (): Promise<IteratorResult<RunEvent>> => {
        // `break` out of a for-await closes the session, for the same reason it does on a watch
        // session: a browser left running after its reader stopped is never what was meant.
        await this.close();

        return { done: true, value: undefined };
      },
    };
  }

  /** Runs, exactly once, and answers with the result every caller shares. */
  #start(): Promise<RunResult> {
    if (this.#started) return this.#started;
    if (this.#closed) {
      // Aborted or closed before it ever ran: answer with the empty result rather than launch a
      // browser nobody is waiting for. The counts are zeroes, `aborted` says why.
      this.#started = Promise.resolve(Run.abort(this.#config));

      return this.#started;
    }

    this.#started = RunCommand.run(this.#config).then((outcome) => {
      const result = this.#snapshot(outcome);
      this.#channel.emit({ kind: 'runEnd', result });
      this.#channel.close();

      return result;
    });
    // The run's own rejection is delivered through `result()`; this keeps a session that nobody
    // awaited from taking the process down with an unhandled rejection.
    this.#started.catch(() => this.#channel.close());

    return this.#started;
  }

  #snapshot(outcome: RunCommand.RunOutcome): RunResult {
    return Run.buildResult(this.#config, outcome);
  }
}
