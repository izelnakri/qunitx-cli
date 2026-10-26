import fs from 'node:fs';
import process from 'node:process';
import { Task } from '../task/index.ts';
import { Stream } from '../stream/index.ts';
import * as Failure from '../result/failure.ts';
import * as BenchCommand from '../commands/bench.ts';
import * as Report from '../bench/report.ts';
import * as Compare from '../bench/compare.ts';
import type { BenchResult, BenchSettings } from '../commands/bench.ts';
import type { BenchReport, BenchFormat } from '../bench/report.ts';
import type { BaselineEntry, Comparison, RegressionRule } from '../bench/compare.ts';

export type { BenchResult } from '../commands/bench.ts';
export type { BenchEntry, BenchStats, BenchDefinition, BenchContext } from '../bench/harness.ts';
export type { BenchReport, BenchFormat } from '../bench/report.ts';
export type { Comparison, BaselineEntry, RegressionRule } from '../bench/compare.ts';

/**
 * Everything `Bench.run()` takes: `qunitx bench`'s flags by their JS names, and `signal` and
 * `onResult`. Watching is `Bench.watch()`'s — a Task has to settle.
 *
 * ```ts
 * const options: BenchOptions = { browser: 'webkit', compare: 'tmp/base.json', threshold: 15 };
 * ```
 */
export type BenchOptions = Omit<BenchSettings, 'watch'>;

/**
 * Why `Bench.run()` or `Bench.watch()` could not run: a setting that will not do, no bench files, or a
 * baseline it could not read.
 *
 * ```ts
 * import type { BenchFailure } from './bench.ts';
 *
 * function describe(failure: BenchFailure) {
 *   return failure.message;
 * }
 * ```
 */
export type BenchFailure = Failure.Of<
  typeof BenchCommand.InvalidBenchSetting | typeof BenchCommand.NoBenchFiles
>;

/**
 * Measures `Deno.bench` files in a real browser, as `qunitx bench` does, and resolves with the
 * report in `deno bench --json`'s shape, its comparison with `compare`'s baseline, and the exit
 * code the command line would exit with. The report is printed to `console` as `format` asks —
 * pass `silentConsole` to print nothing; `onResult` hears of each bench as it is measured, and
 * `signal` stops the run, resolving with what was measured (`aborted: true`).
 *
 * **A failed or regressed bench is a result** (`ok: false`), not a rejection; it rejects only
 * when nothing could run.
 *
 * ```ts
 * import * as Bench from './bench.ts';
 * import { silentConsole } from '../console.ts';
 *
 * // Defined, not invoked: launches a browser.
 * async function render() {
 *   const result = await Bench.run('benches/render.bench.ts', { console: silentConsole });
 *   return result.report.benches.map((entry) => entry.name);
 * }
 * ```
 */
export function run(
  targets: string | string[] = [],
  options: BenchOptions = {},
): Task<BenchResult, BenchFailure> {
  return Task(async () => {
    if ((options as BenchSettings).watch !== undefined) {
      throw BenchCommand.InvalidBenchSetting({
        setting: 'watch',
        reason: 'Bench.run() runs once: Bench.watch() is the session that measures again on change',
      });
    }
    return await BenchCommand.run([targets].flat(), options);
  }).mapErr((error) => {
    if (BenchCommand.InvalidBenchSetting.is(error) || BenchCommand.NoBenchFiles.is(error)) {
      return error;
    }
    throw error;
  });
}

/**
 * A `Bench.watch()` session: measured once, then again whenever a file a bench imports changes —
 * each run's result in turn as you iterate it, or through {@link BenchWatchSession.results}.
 *
 * ```ts
 * import type { BenchWatchSession } from './bench.ts';
 *
 * // Defined, not invoked: a real session holds a browser open.
 * async function firstRegression(session: BenchWatchSession) {
 *   for await (const result of session) if (result.comparison?.regressions.length) return result;
 * }
 * ```
 */
export interface BenchWatchSession extends AsyncIterable<BenchResult> {
  /** The first run's result, measured before the session resolved. */
  readonly initial: BenchResult;
  /** The latest run's result: `initial` until something runs again. */
  readonly latest: BenchResult;
  /** Whether a run is in flight. */
  readonly running: boolean;
  /** Bundles every file again and measures now, resolving with that run's result. */
  run(): Promise<BenchResult>;
  /** Every run's result after `initial`, as a {@link Stream}: the same as iterating the session. */
  results(): Stream<BenchResult>;
  /** Stops watching and closes the browser; iteration ends. */
  close(): Promise<void>;
}

/**
 * Measures the bench files, then again whenever a file one of them imports changes: the API twin
 * of `qunitx bench --watch`. Resolves once the first run is measured. `signal` closes the session.
 *
 * ```ts
 * import * as Bench from './bench.ts';
 * import { silentConsole } from '../console.ts';
 *
 * // Defined, not invoked: holds a browser open until closed.
 * async function measureWhileEditing() {
 *   const session = await Bench.watch('benches', { console: silentConsole });
 *   for await (const result of session) console.log(result.report.benches.length);
 * }
 * ```
 */
export function watch(
  targets: string | string[] = [],
  options: BenchOptions = {},
): Task<BenchWatchSession, BenchFailure> {
  return Task(async () => {
    const prepared = await BenchCommand.prepare([targets].flat(), options);
    const launched = await BenchCommand.launch(prepared);
    try {
      const initial = await launched.measure();
      const session = new WatchSession(launched, initial, await launched.watchDirectories());
      const signal = options.signal;
      if (signal?.aborted) await session.close();
      else signal?.addEventListener('abort', () => void session.close(), { once: true });
      return session as BenchWatchSession;
    } catch (error) {
      await launched.close();
      throw error;
    }
  }).mapErr((error) => {
    if (BenchCommand.InvalidBenchSetting.is(error) || BenchCommand.NoBenchFiles.is(error)) {
      return error;
    }
    throw error;
  });
}

// Saves a burst of editor writes from measuring the same change several times.
const DEBOUNCE_MS = 75;

class WatchSession implements BenchWatchSession {
  readonly initial: BenchResult;
  #latest: BenchResult;
  #running: Promise<BenchResult> | null = null;
  #pending = false;
  #closed = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #launched: BenchCommand.LaunchedBench;
  readonly #watchers: fs.FSWatcher[];
  readonly #results = Stream.channel<BenchResult>({ capacity: 1_000, overflow: 'dropOldest' });

  constructor(launched: BenchCommand.LaunchedBench, initial: BenchResult, directories: string[]) {
    this.#launched = launched;
    this.initial = initial;
    this.#latest = initial;
    // Folders, not files: an editor saves by renaming over the file, which ends a file's watch.
    this.#watchers = [...new Set(directories)].map((directory) =>
      fs.watch(directory, () => this.#changed()),
    );
  }

  get latest(): BenchResult {
    return this.#latest;
  }

  get running(): boolean {
    return this.#running !== null;
  }

  run(): Promise<BenchResult> {
    if (this.#closed) return Promise.reject(new Error('Bench.watch: the session is closed'));
    // One run at a time; a change during one is measured once it ends.
    if (this.#running) {
      this.#pending = true;
      return this.#running;
    }
    this.#running = (async () => {
      try {
        await this.#launched.rebuild();
        const result = await this.#launched.measure();
        this.#latest = result;
        this.#results.emit(result);
        return result;
      } finally {
        this.#running = null;
        if (this.#pending && !this.#closed) {
          this.#pending = false;
          void this.run();
        }
      }
    })();
    return this.#running;
  }

  results(): Stream<BenchResult> {
    return this.#results.stream;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    for (const watcher of this.#watchers) watcher.close();
    await this.#running?.catch(() => {});
    await this.#launched.close();
    this.#results.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<BenchResult> {
    return this.#results.stream[Symbol.asyncIterator]();
  }

  #changed(): void {
    if (this.#closed) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.run().catch(() => {}), DEBOUNCE_MS);
  }
}

/**
 * A bench report rendered as `format` asks — `deno bench`'s table, its JSON, Markdown or CSV — with
 * each bench's change from `comparison`'s baseline when given. For a report saved earlier, or one
 * `deno bench --json` wrote: no browser involved.
 *
 * ```ts
 * import * as Bench from './bench.ts';
 *
 * Bench.render({ version: 1, runtime: 'Deno/2.9', cpu: 'Intel', benches: [] }, 'markdown').startsWith('**CPU** Intel'); // true
 * ```
 */
export function render(
  report: BenchReport,
  format: BenchFormat = 'pretty',
  comparison: Comparison | null = null,
  color = false,
): string {
  return Report.render(report, format, comparison, color);
}

/**
 * Compares a bench report with a baseline — another report, `deno bench --json`'s output, or a
 * `{ results: { name: avg } }` map — under `qunitx bench --compare`'s rule: slower by over
 * `threshold` percent (10, doubled under 1µs) and by over `minDelta` nanoseconds (1000). `root`
 * is the project the reports' file URLs are made relative to, so two checkouts' match. No
 * browser involved: compare a Chromium run with a Firefox one, or with `deno bench`.
 *
 * ```ts
 * import * as Bench from './bench.ts';
 *
 * const empty = { version: 1 as const, runtime: '', cpu: '', benches: [] };
 * Bench.compare(empty, { results: {} }).regressions; // []
 * ```
 */
export function compare(
  report: BenchReport,
  baseline: unknown,
  rule: Partial<RegressionRule> = {},
  root: string = process.cwd(),
): Comparison {
  const entries: BaselineEntry[] = Compare.readBaseline(baseline, root);
  return Compare.compare(
    report,
    entries,
    { threshold: rule.threshold ?? 10, minDelta: rule.minDelta ?? 1_000 },
    root,
  );
}
