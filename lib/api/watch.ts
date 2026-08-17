import * as TestCommand from '../commands/test.ts';
import { Task } from '../task/index.ts';
import * as TestRun from './test.ts';
import { EventsChannel, findAPIReporterFrom, type RunEvent } from './reporter.ts';

import { Stream } from '../stream/index.ts';
import * as Options from './options.ts';
import * as Config from '../setup/config.ts';
import type { RunFailure, RunResult } from './test.ts';
import type { UserRunOptions } from './options.ts';
import type { Config as ResolvedConfig } from '../types.ts';
// The unstable escape-hatch types. Imported for their shape only; re-exporting them would make
// playwright-core and esbuild part of this package's contract, which is exactly what the
// "outside semver" note on those properties refuses to do.
import type { Browser, Page } from 'playwright-core';
import type { BuildContext } from 'esbuild';
import type { FSWatcher } from 'node:fs';
import type { HTTPServer } from '../web/index.ts';

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
  /**
   * The most recent run's result — `initial` until something re-runs.
   *
   * The session's current state, readable without consuming the iteration. A UI redrawing for
   * some reason of its own (a resize, a keystroke) needs the last result again, and taking it
   * from the iterator would steal it from the loop that is driving the redraws.
   */
  readonly latest: RunResult;
  /** Whether a run is in flight right now. */
  readonly running: boolean;
  /** Re-runs now, optionally scoped to `files`, and resolves with that run's result. */
  run(files?: string[]): Promise<RunResult>;
  /**
   * Runs the whole suite, dropping any line-target selectors this session was scoped to.
   *
   * Not the same as `run()`: a session started from `test/cart-test.ts#34` stays pinned to that
   * line until something clears the pin, and only this clears it. `-t`/`-m` survive — those are a
   * standing instruction about which tests to run rather than a starting point.
   */
  runAll(): Promise<RunResult>;
  /**
   * Re-runs the files that last failed, or repeats the last run when nothing has failed yet —
   * saying so as an `info` notice on the result rather than silently doing something else.
   */
  runFailed(): Promise<RunResult>;
  /**
   * Cuts the current run short: the browser drops the rest of its queue and the run ends where it
   * is, with `aborted: true` on its result.
   *
   * Resolves once the interrupted run has settled, so `await session.abort()` leaves the session
   * idle and ready for the next verb. Aborting while nothing is running is a no-op.
   */
  abort(): Promise<void>;
  /**
   * The fine-grained feed: every event of every run, flat and in order, until the session closes.
   *
   * The same events for a watch session as for a single run, so a UI written against one works
   * against the other — `runStart` … `test` … `runEnd`, then again for the next rerun. Iterating
   * the session itself gives the coarse view (one complete result per rerun); this gives the view
   * a progress bar needs.
   *
   * Buffers from the first call, not from the first read, so events between calling this and
   * starting to iterate are not lost. One consumer, like the session's own iteration.
   */
  events(): Stream<RunEvent>;
  /**
   * The coarse feed as a {@link Stream}: one complete {@link RunResult} per rerun, with the
   * combinators attached. `for await (const r of session)` is the same sequence.
   *
   * ```ts
   * // Defined, not invoked: a real session holds a browser open.
   * async function untilGreen(session: WatchSession) {
   *   const [red] = await session.results().filter((r) => !r.ok).take(1).collect();
   *
   *   return red.failures;
   * }
   * ```
   */
  results(): Stream<RunResult>;
  /**
   * How many events the feed dropped because a consumer fell behind. `0` unless something stalls.
   *
   * A watch session has no natural end, so an `events()` feed nobody drains would grow for as
   * long as the session lives — the cap is what stops that, and this is how you see it happen.
   */
  readonly droppedEvents: number;
  /**
   * Tears the session's machinery down and boots it again — browser, page, server, esbuild
   * context and watchers — then runs the suite once, resolving with that run's result.
   *
   * **The session survives.** `this` is the same object, and `events()` / `results()` keep
   * streaming straight across: a restart is one transition in the life of a session, not a close
   * followed by a new one. If it ended the feeds it would be `close()` plus `watch()` with extra
   * steps, and there would be no reason for it to exist.
   *
   * For picking up a change no rerun can see — an edited `package.json`, a plugin whose module
   * you replaced, a browser wedged by the page under test.
   *
   * `initial` still refers to the run the session STARTED with; it is readonly and callers hold
   * it. The restart's own first run arrives through `results()` and `latest` like any other.
   *
   * **{@link url} may change.** The old port is released and reacquired, and if something took it
   * in between, the new server binds the next one — so re-read `url` afterwards rather than
   * caching it. The live objects are replaced too — all but {@link WatchSession.esbuild}, which a
   * restart deliberately keeps.
   *
   * Ordering: it takes the same queue reruns take, so a restart waits for an in-flight run and a
   * rerun asked for during one waits for the restart. Calling it twice concurrently gives both
   * callers the SAME restart rather than tearing down twice.
   *
   * ```ts
   * import type { WatchSession } from './watch.ts';
   *
   * // Defined, not invoked: needs a live session.
   * async function afterConfigChange(session: WatchSession) {
   *   const result = await session.restart();
   *   return { total: result.counts.total, url: session.url };
   * }
   * ```
   */
  restart(): Promise<RunResult>;
  /** Stops watching, closes the browser and server, and ends the iteration. Idempotent. */
  close(): Promise<void>;

  // ── Live objects — OUTSIDE SEMVER ──────────────────────────────────────────────────────────
  //
  // The five below are the session's actual machinery, handed over unwrapped so a caller can do
  // something this API has not thought of: drive the page with Playwright, add a route to the
  // server, read esbuild's metafile. They are an escape hatch, and an honestly labelled one —
  // three of the five are types this project does not own, and pinning their shape would make
  // every playwright-core or esbuild upgrade a breaking change here. They may change or vanish
  // in a MINOR release. Everything above this line is the supported surface.
  //
  // Four of the five are replaced by `restart()` — re-read them after one rather than holding a
  // reference across it, and treat them as closed once `close()` has resolved. `esbuild` is the
  // exception: a restart reuses the same config, so a fresh context would hold the very same
  // plugin objects, and it is deliberately kept rather than disposed and respawned.

  /**
   * Playwright's `Browser` for this session — **unstable**, playwright-core's type.
   *
   * ```ts
   * import type { WatchSession } from './watch.ts';
   *
   * // Defined, not invoked: needs a live session.
   * async function contexts(session: WatchSession) {
   *   return session.browser.contexts().length;
   * }
   * ```
   */
  readonly browser: Browser;
  /**
   * The page the suite runs in — **unstable**, playwright-core's type.
   *
   * ```ts
   * import type { WatchSession } from './watch.ts';
   *
   * // Defined, not invoked: needs a live session.
   * async function shoot(session: WatchSession) {
   *   return await session.page.screenshot();
   * }
   * ```
   */
  readonly page: Page;
  /**
   * The HTTP + WebSocket server serving the bundle — **unstable**, this project's own
   * `HTTPServer` rather than a documented interface.
   *
   * ```ts
   * import type { WatchSession } from './watch.ts';
   *
   * // Defined, not invoked: needs a live session.
   * function addRoute(session: WatchSession) {
   *   session.webServer.get('/fixture.json', (_request, response) => response.json({ ok: true }));
   * }
   * ```
   */
  readonly webServer: HTTPServer;
  /**
   * esbuild's incremental `BuildContext` — **unstable**, esbuild's type.
   *
   * `null` until the first build has created one, and again after a `restart()` until that
   * session's first build. Genuinely nullable rather than defensively typed: the context is
   * created lazily by the first bundle, so a caller reaching for it early would find nothing.
   *
   * ```ts
   * import type { WatchSession } from './watch.ts';
   *
   * // Defined, not invoked: needs a live session that has built at least once.
   * async function rebuild(session: WatchSession) {
   *   return session.esbuild ? await session.esbuild.rebuild() : null;
   * }
   * ```
   */
  readonly esbuild: BuildContext | null;
  /**
   * The live `fs.watch` handles keyed by watched path — **unstable**, and a PARTIAL view: the
   * parent-directory watchers, rescan intervals and symlink pollers the session also owns are
   * not in here. It answers "what is being watched", not "every handle the watcher holds".
   *
   * The record is the watcher's own object, so it reflects additions and removals as they
   * happen. After `close()` the handles in it are closed but the keys remain.
   *
   * ```ts
   * import type { WatchSession } from './watch.ts';
   *
   * // Defined, not invoked: needs a live session.
   * function watchedPaths(session: WatchSession) {
   *   return Object.keys(session.fileWatchers);
   * }
   * ```
   */
  readonly fileWatchers: Record<string, FSWatcher>;
}

/**
 * Starts a watch session: builds once, runs once, then re-runs on every save until closed.
 *
 * Resolves as soon as that first run has finished and the watchers are armed, so there is no
 * window in which a save could be missed. The process then stays alive because the session holds
 * a browser and a bound port — `close()` is what releases both.
 *
 * Unlike the CLI's `--watch`, nothing is bound to stdin: no keyboard shortcuts are installed and
 * the host's terminal is left alone. The behaviours behind those shortcuts are still here as
 * {@link WatchSession.runAll}, {@link WatchSession.runFailed} and {@link WatchSession.abort} —
 * the CLI binds keys to the same methods, so a terminal UI built on this API is not reimplementing
 * them.
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
  options: UserRunOptions | string | string[] = {},
): Task<WatchSession, RunFailure> {
  return Task(async () => {
    const config = await Config.setup({ ...Options.from(options), watch: true });
    const begunAt = Date.now();
    const inner = await TestCommand.watch(config);

    // The initial run is snapshotted here, before the session installs its rerun listener: it has
    // already finished by the time `TestCommand.watch` resolves, so it would never fire one and
    // the one result missing from the iteration. Its duration has to be measured around that call
    // for the same reason — nothing can recover it afterwards.
    const session = new Session(inner, config, snapshot(config, Date.now() - begunAt));
    // For a watch session `signal` means "stop watching" — there is no single run to cut short,
    // and the session's own `abort()` covers the one in flight. An already-aborted signal still
    // pays for the initial run, because the session's contract is that `initial` is a real result.
    const signal = config.state.signal;
    if (signal) {
      if (signal.aborted) await session.close();
      else signal.addEventListener('abort', () => void session.close(), { once: true });
    }

    return session;
  });
}

/**
 * The live session. A class rather than an object literal because it owns a queue: reruns the
 * *file watcher* triggers have no caller to hand a result to, so they are buffered for whoever
 * is iterating — and a consumer that arrives late still sees every one of them.
 */
class Session implements WatchSession {
  readonly initial: RunResult;
  #inner: TestCommand.WatchSession;
  #config: ResolvedConfig;
  #results = Stream.channel<RunResult>({ capacity: 1_000, overflow: 'dropOldest' });
  #events: EventsChannel | null = null;
  #latest: RunResult;
  #published = 0;
  #closed = false;
  #restarting: Promise<RunResult> | null = null;

  constructor(inner: TestCommand.WatchSession, config: ResolvedConfig, initial: RunResult) {
    this.#inner = inner;
    this.#config = config;
    this.initial = initial;
    this.#latest = initial;
    // The initial run is the iteration's first element, so a `for await` sees the whole history
    // rather than starting from whatever happens to change next.
    this.#results.emit(initial);
    // Every rerun goes through the same reporters, and `onRunEnd` is the last thing a run does —
    // which makes it the one honest signal that a result is complete and ready to snapshot.
    config.state.reporters.push({
      onRunEnd: (_context, info) => this.#publish(info.durationMs),
    });
  }

  get url(): string {
    return this.#inner.url;
  }

  get latest(): RunResult {
    return this.#latest;
  }

  get running(): boolean {
    return this.#inner.running;
  }

  // The unstable live objects. Getters rather than fields so they follow `#inner` and `#config`
  // across a restart instead of freezing whatever existed when the session was constructed.

  get browser(): Browser {
    return this.#inner.connections.browser;
  }

  get page(): Page {
    return this.#inner.connections.page;
  }

  get webServer(): HTTPServer {
    return this.#inner.connections.server;
  }

  get esbuild(): BuildContext | null {
    return this.#config.state.group.build.context ?? null;
  }

  get fileWatchers(): Record<string, FSWatcher> {
    return this.#inner.fileWatchers;
  }

  run(files?: string[]): Promise<RunResult> {
    return this.#drive(() => this.#inner.run(files));
  }

  runAll(): Promise<RunResult> {
    return this.#drive(() => this.#inner.runAll());
  }

  runFailed(): Promise<RunResult> {
    return this.#drive(() => this.#inner.runFailed());
  }

  async abort(): Promise<void> {
    this.#inner.abort();
    // Waiting for quiet, NOT driving a run: the interrupted run publishes its own truncated
    // result through `onRunEnd` like any other, and `#drive` would have manufactured a second,
    // empty one for an abort that arrived while nothing was running.
    await this.#inner.settled();
  }

  events(): Stream<RunEvent> {
    // Attached on the first call and kept: a second call must not hand back a feed that starts
    // mid-run, and attaching a second reporter would double every event on the first feed.
    if (!this.#events) {
      const channel = EventsChannel.build();
      this.#events = channel;
      this.#config.state.reporters.push(channel.reporter);
    }

    return this.#events.stream;
  }

  results(): Stream<RunResult> {
    return this.#results.stream;
  }

  get droppedEvents(): number {
    return (this.#events?.dropped ?? 0) + this.#results.dropped;
  }

  restart(): Promise<RunResult> {
    // One restart at a time, and a second caller joins the first rather than starting a teardown
    // of the session the first is still building. The inner session's own queue cannot serialise
    // this — it is the thing being destroyed — so the guard lives here, at the only level that
    // outlives the transition.
    this.#restarting ??= this.#restart().finally(() => (this.#restarting = null));

    return this.#restarting;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // A close during a restart waits for it: tearing down half-built machinery races the boot
    // and leaks whichever handles it had already created. The restart checks `#closed` when it
    // lands and closes what it built, so the wait is bounded by one boot.
    await Task(this.#restarting).ignore('watch session restart in flight');
    await this.#inner.close();
    this.#results.close();
    this.#events?.close();
  }

  /**
   * The transition itself. Never called directly — {@link restart} owns the de-duplication.
   *
   * The config object is REUSED rather than rebuilt. That is what keeps the feeds alive across
   * the restart: both are wired by pushing reporters onto `config.state.reporters`, so a fresh
   * `Config.setup()` would hand the new session a different array and leave `events()` and
   * `results()` open but permanently silent.
   */
  async #restart(): Promise<RunResult> {
    // Outside the teardown, as `runAll` does it: abort asks the page to drop its queue, and
    // `settled()` is what waits for the run that was interrupted to finish unwinding.
    this.#inner.abort();
    await this.#inner.settled();
    await this.#inner.teardown();

    // Every aborter registered on this state closes over the server just torn down; the set is
    // never pruned, so without this each restart leaves another closure publishing to a dead
    // socket. Watch mode registers exactly one per boot, so clearing is precise here.
    this.#config.state.aborters.clear();

    // Through `#drive`, exactly like every other verb, and for a reason worth stating: the
    // reporter shim that publishes runs lives on `config.state.reporters`, which this restart
    // deliberately reuses — so the reboot's own initial run DOES reach it, and publishing here as
    // well emitted two results for one run. `#drive` returns what that run published, and only
    // synthesises a result when nothing was published at all (a boot that died in the bundler).
    const result = await this.#drive(async () => {
      this.#inner = await TestCommand.watch(this.#config);
    });
    // `close()` may have been called while the boot was in flight; it is waiting on this promise,
    // so nothing else will release what was just built unless it is released here.
    if (this.#closed) await this.#inner.close();

    return result;
  }

  [Symbol.asyncIterator](): AsyncIterator<RunResult> {
    const inner = this.#results.stream[Symbol.asyncIterator]();

    return {
      next: () => inner.next(),
      return: async (): Promise<IteratorResult<RunResult>> => {
        // `break` out of a for-await closes the session: leaving a browser running after the
        // loop that was reading it has stopped is never what was meant.
        await this.close();

        return { done: true, value: undefined };
      },
    };
  }

  /**
   * Runs one verb and answers with the result it produced.
   *
   * The `#published` comparison is what makes that "the result it produced" rather than "whatever
   * is latest": a rerun that died in the bundler never reaches `onRunEnd`, so nothing was
   * published, and returning the previous run's result would report a build error as the last
   * green run.
   */
  async #drive(verb: () => Promise<void>): Promise<RunResult> {
    const before = this.#published;
    const startedAt = Date.now();
    await verb();
    if (this.#published === before) this.#publish(Date.now() - startedAt);

    return this.#latest;
  }

  /** Hands a finished run to whoever is iterating, or queues it until someone is. */
  #publish(durationMs: number): void {
    this.#published++;
    this.#latest = snapshot(this.#config, durationMs);
    this.#results.emit(this.#latest);
    this.#events?.emit({ kind: 'runEnd', result: this.#latest });
  }
}

/**
 * Freezes the run that just finished into a result, then clears the collector for the next one.
 *
 * The exit code is derived here rather than carried in: a watch rerun has no exit code, because
 * nothing exits — but "did this rerun pass" is exactly as meaningful, and is the same question
 * `failed` answers for the batch runner.
 */
function snapshot(config: ResolvedConfig, durationMs: number): RunResult {
  const failed = config.state.results.counter.failed > 0;
  const finishedAt = Date.now();
  const result = TestRun.buildResult(config, {
    exitCode: failed ? 1 : 0,
    durationMs,
    startedAt: finishedAt - durationMs,
    finishedAt,
  });
  findAPIReporterFrom(config).reset();

  return result;
}
