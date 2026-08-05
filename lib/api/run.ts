import * as Config from '../setup/config.ts';
import * as Run from '../commands/run.ts';
import { JUnitReporter } from '../reporters/junit.ts';
import { Task } from '../task/index.ts';
import { unwrap } from '../result/result.ts';
import { buildResult, type RunResult } from './result.ts';
import * as RunState from '../setup/run-state.ts';
import {
  normalizeOptions,
  resolveReporting,
  toConfigOptions,
  validate,
  type InvalidOptionFailure,
  type ResolvedReporting,
  type RunOptions,
} from './options.ts';
import type { Reporter } from '../reporters/types.ts';
import type { Config as ResolvedConfig } from '../types.ts';

/**
 * Every way a run can fail to happen: an option the runner will not accept, an unreadable input,
 * a directory with no `package.json` above it, an esbuild plugin that will not load.
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
export type RunFailure = Config.ConfigFailure | InvalidOptionFailure;

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
    validate(resolved);
    const reporting = resolveReporting(resolved);
    // `unwrap` moves a declared config failure into this Task's E channel by throwing it by
    // identity, so `RunFailure` stays a union the caller can discriminate rather than a
    // stringified message.
    const config = unwrap(await Config.setup(toConfigOptions(resolved, reporting)).result());
    // Checked here rather than inside `withSignal`, because the first thing a run does is reset
    // its accumulators — including the aborted flag. A request made before that point would be
    // cleared by the very run it was meant to stop, so the only honest answer to an
    // already-cancelled run is to not start one.
    if (resolved.signal?.aborted) return abortedBeforeStart(config, reporting);

    const outcome = await withSignal(config, resolved.signal, () => Run.run(config));

    return buildResult(config, outcome, reporting.collector, junitXml(reporting.reporters));
  });
}

/**
 * The JUnit document, when the run was asked for one. Read off the reporter rather than the
 * disk: the caller may want to publish it without touching the filesystem, and it is the same
 * string `onRunEnd` just wrote.
 *
 * ```ts
 * junitXml([]); // null — no JUnit reporter was attached, so there is no document
 * ```
 */
/**
 * The result of a run that was cancelled before it began: no browser, no tests, `aborted: true`.
 *
 * A result rather than a rejection, because cancelling is not failing — the caller asked for this
 * and gets the same shape back, so the code reading the result needs no separate path.
 *
 * ```ts
 * import type { Config } from '../types.ts';
 * import { resolveReporting } from './options.ts';
 *
 * // Defined, not invoked: needs a resolved Config.
 * function cancelled(config: Config) {
 *   return abortedBeforeStart(config, resolveReporting({})).aborted; // true
 * }
 * ```
 */
export function abortedBeforeStart(
  config: ResolvedConfig,
  reporting: ResolvedReporting,
): RunResult {
  config.state.results.aborted = true;
  const now = Date.now();

  // Exit 1: a run that produced no passing tests did not succeed. `aborted` is what tells a
  // caller it was their own doing rather than a red suite.
  return buildResult(
    config,
    { exitCode: 1, durationMs: 0, startedAt: now, finishedAt: now },
    reporting.collector,
    null,
  );
}

/**
 * Runs `work` with `signal` wired to the run's abort mechanism, and unsubscribes afterwards.
 *
 * The listener is removed on the way out because a caller may reuse one controller across several
 * runs — a common enough shape (one "stop everything" button) that leaking a listener per run
 * onto a long-lived signal would be a real accumulation rather than a theoretical one.
 *
 * ```ts
 * import type { Config } from '../types.ts';
 *
 * // Defined, not invoked: a real run needs a resolved Config.
 * function cancellable(config: Config, signal: AbortSignal) {
 *   return withSignal(config, signal, () => Promise.resolve('done'));
 * }
 * ```
 */
export async function withSignal<T>(
  config: ResolvedConfig,
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (!signal) return await work();

  const abort = () => RunState.requestAbort(config.state);
  signal.addEventListener('abort', abort);
  try {
    return await work();
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/**
 * The JUnit document, when the run was asked for one. Read off the reporter rather than the
 * disk: the caller may want to publish it without touching the filesystem, and it is the same
 * string `onRunEnd` just wrote.
 *
 * ```ts
 * junitXml([]); // null — no JUnit reporter was attached, so there is no document
 * ```
 */
export function junitXml(reporters: readonly Reporter[]): string | null {
  const junit = reporters.find((reporter) => reporter instanceof JUnitReporter);

  return junit ? junit.xml() : null;
}
