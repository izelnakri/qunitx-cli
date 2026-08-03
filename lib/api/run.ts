import * as Config from '../setup/config.ts';
import * as Run from '../commands/run.ts';
import { JUnitReporter } from '../reporters/junit.ts';
import { Task } from '../task/index.ts';
import { unwrap } from '../result/result.ts';
import { buildResult, type RunResult } from './result.ts';
import { normalizeOptions, resolveReporting, toConfigOptions, type RunOptions } from './options.ts';
import type { Reporter } from '../reporters/types.ts';

/**
 * Every way a run can fail to happen: a rejected option, an unreadable input, a directory with
 * no `package.json` above it, an esbuild plugin that will not load.
 *
 * Note what is *not* here. Failing tests are not a failure — they are a {@link RunResult} with
 * `ok: false`. This union is only for the runner being unable to answer the question.
 *
 * ```ts
 * import { Failure } from '../task/index.ts';
 *
 * // Defined, not invoked: a real failure comes back from `run(...).result()`.
 * function explain(failure: RunFailure) {
 *   return `${failure.code}: ${Failure.format(failure)}`; // 'InvalidFlag: …'
 * }
 * ```
 */
export type RunFailure = Config.ConfigFailure;

/**
 * Runs the suite once in a real browser and resolves with everything it produced.
 *
 * Silent by default: with no `reporter`, nothing reaches stdout and the {@link RunResult} is the
 * entire output. Pass `reporter: 'tap'` (or `'spec'`, `'dot'`, `'github'`, or your own object)
 * to get the CLI's text as well — the result comes back either way.
 *
 * Lazy, because it is a {@link Task}: no browser starts until you await it. `await run(…)`
 * resolves the result or throws a {@link RunFailure}; `run(…).result()` hands back the bare
 * union instead, for code that would rather branch than catch.
 *
 * ```ts
 * import { run } from './run.ts';
 *
 * // Defined, not invoked: launches a browser and runs the project's tests.
 * async function checkCart() {
 *   const result = await run({ inputs: ['test/'], filter: 'Cart' });
 *   return result.ok ? 'green' : result.failures.map((test) => test.fullName);
 * }
 * ```
 */
export function run(options: RunOptions | string | string[] = {}): Task<RunResult, RunFailure> {
  return Task(async () => {
    const resolved = normalizeOptions(options);
    const reporting = resolveReporting(resolved);
    // `unwrap` moves a declared config failure into this Task's E channel by throwing it by
    // identity, so `RunFailure` stays a union the caller can discriminate rather than a
    // stringified message.
    const config = unwrap(await Config.setup(toConfigOptions(resolved, reporting)).result());
    const outcome = await Run.run(config);

    return buildResult(config, outcome, reporting.collector, junitXml(reporting.reporters));
  });
}

/**
 * The JUnit document, when the run was asked for one. Read off the reporter rather than the
 * disk: the caller may want to publish it without touching the filesystem, and it is the same
 * string `onRunEnd` just wrote.
 */
export function junitXml(reporters: readonly Reporter[]): string | null {
  const junit = reporters.find((reporter) => reporter instanceof JUnitReporter);

  return junit ? junit.xml() : null;
}
