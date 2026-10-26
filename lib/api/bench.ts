import { Task } from '../task/index.ts';
import * as Failure from '../result/failure.ts';
import * as BenchCommand from '../commands/bench.ts';
import type { BenchResult, BenchSettings } from '../commands/bench.ts';

export type { BenchResult } from '../commands/bench.ts';
export type { BenchEntry, BenchStats, BenchDefinition, BenchContext } from '../bench/harness.ts';
export type { BenchReport, BenchFormat } from '../bench/report.ts';
export type { Comparison, BaselineEntry, RegressionRule } from '../bench/compare.ts';

/**
 * Everything `Bench.run()` takes: `qunitx bench`'s flags by their JS names. Watching is the command
 * line's alone — a Task has to settle.
 *
 * ```ts
 * const options: BenchOptions = { browser: 'webkit', compare: 'tmp/base.json', threshold: 15 };
 * ```
 */
export type BenchOptions = Omit<BenchSettings, 'watch'>;

/**
 * Why `Bench.run()` could not run: a setting that will not do, no bench files, or a baseline it
 * could not read.
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
 * pass `silentConsole` to print nothing. **A failed or regressed bench is a result** (`ok:
 * false`), not a rejection; it rejects only when nothing could run.
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
    const { watch: _watch, ...rest } = options as BenchSettings;
    return await BenchCommand.run([targets].flat(), rest);
  }).mapErr((error) => {
    if (BenchCommand.InvalidBenchSetting.is(error) || BenchCommand.NoBenchFiles.is(error)) {
      return error;
    }
    throw error;
  });
}
