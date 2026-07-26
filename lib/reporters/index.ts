import { TAPReporter } from './tap.ts';
import { SpecReporter } from './spec.ts';
import { DotReporter } from './dot.ts';
import { GithubReporter } from './github.ts';
import { JUnitReporter } from './junit.ts';
import { updateCounter } from './types.ts';
import type { Reporter, ReporterName, RunStartInfo, RunEndInfo, TestDetails } from './types.ts';
import type { Config } from '../types.ts';

// The `--reporter` value -> stdout reporter. Keyed by ReporterName so adding a name to
// REPORTERS without wiring it up here is a type error rather than a silent fall back to tap.
const STDOUT_REPORTERS: Record<ReporterName, new () => Reporter> = {
  tap: TAPReporter,
  spec: SpecReporter,
  dot: DotReporter,
  github: GithubReporter,
};

/**
 * Reporter wiring. `config.reporter` selects exactly one stdout reporter; artifact
 * reporters (JUnit) are additive and stack on top. Built once per run in `Config.setup` and
 * shared by every concurrent group — the group configs are spread off the parent config, so
 * they all reference this same array (the same way the run counter is shared).
 *
 * ```ts
 * import type { Config } from '../types.ts';
 *
 * const reporters = (config: Config) => create(config); // 1 stdout reporter, +JUnit if --junit
 * ```
 */
export function create(config: Config): Reporter[] {
  // Exactly one stdout reporter, plus any additive artifact reporters. A plain run is a
  // 1-element array; `--reporter=dot --junit` is 2 — one owning stdout, one owning the file.
  return [stdoutReporter(config), ...(config.junit ? [new JUnitReporter()] : [])];
}

/**
 * Emits run start to every active reporter. In watch mode this fires once per rerun.
 *
 * ```ts
 * import type { Config } from '../types.ts';
 * import type { RunStartInfo } from './types.ts';
 *
 * // Defined, not invoked: fans out to the run's live reporters, which write to stdout.
 * function announce(config: Config, info: RunStartInfo) {
 *   runStart(config, info);
 * }
 * ```
 */
export function runStart(config: Config, info: RunStartInfo): void {
  config.state.reporters.forEach((reporter) => reporter.onRunStart?.(config, info));
}

/**
 * Applies one `testEnd` to the counters, then fans it out to every active reporter.
 * The counter update happens here — exactly once, before any reporter runs — so counts stay
 * correct regardless of how many reporters are attached.
 *
 * ```ts
 * import type { Config } from '../types.ts';
 * import type { TestDetails } from './types.ts';
 *
 * // Defined, not invoked: mutates the shared counter and writes reporter output.
 * function record(config: Config, details: TestDetails) {
 *   testEnd(config, details); // counter first, then every reporter sees the same totals
 * }
 * ```
 */
export function testEnd(config: Config, details: TestDetails): void {
  updateCounter(config.state.results.counter, details);
  config.state.reporters.forEach((reporter) => reporter.onTestEnd?.(config, details));
}

/**
 * Emits run end to every active reporter, awaiting any that flush asynchronously.
 *
 * ```ts
 * import type { Config } from '../types.ts';
 * import type { RunEndInfo } from './types.ts';
 *
 * // Defined, not invoked: JUnit flushes its XML file here.
 * async function finish(config: Config, info: RunEndInfo) {
 *   await runEnd(config, info);
 * }
 * ```
 */
export async function runEnd(config: Config, info: RunEndInfo): Promise<void> {
  for (const reporter of config.state.reporters) {
    await reporter.onRunEnd?.(config, info);
  }
}

// Exactly one stdout reporter per run. `--reporter` is validated in Args.parse, so an
// unknown value never reaches here; tap is the default and the fallback.
function stdoutReporter(config: Config): Reporter {
  return new (STDOUT_REPORTERS[config.reporter ?? 'tap'] ?? TAPReporter)();
}
