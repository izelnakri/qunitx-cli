import { TAPReporter } from './tap.ts';
import { SpecReporter } from './spec.ts';
import { DotReporter } from './dot.ts';
import { GithubReporter } from './github.ts';
import { JUnitReporter } from './junit.ts';
import { updateCounter } from './types.ts';
import type {
  BrowserLog,
  Notice,
  Reporter,
  ReporterName,
  RunStartInfo,
  RunEndInfo,
  TestDetails,
} from './types.ts';
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
 * import * as Reporter from './index.ts';
 *
 * import type { Config } from '../types.ts';
 *
 * const reporters = (config: Config) => Reporter.create(config); // 1 stdout reporter, +JUnit if --junit
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
 * import * as Reporter from './index.ts';
 *
 * import type { Config } from '../types.ts';
 * import type { RunStartInfo } from './types.ts';
 *
 * // Defined, not invoked: fans out to the run's live reporters, which write to stdout.
 * function announce(config: Config, info: RunStartInfo) {
 *   Reporter.runStart(config, info);
 * }
 * ```
 */
export function runStart(config: Config, info: RunStartInfo): void {
  fanOut(config, 'onRunStart', (reporter) => reporter.onRunStart?.(config, info));
}

/**
 * Applies one `testEnd` to the counters, then fans it out to every active reporter.
 * The counter update happens here — exactly once, before any reporter runs — so counts stay
 * correct regardless of how many reporters are attached.
 *
 * ```ts
 * import * as Reporter from './index.ts';
 *
 * import type { Config } from '../types.ts';
 * import type { TestDetails } from './types.ts';
 *
 * // Defined, not invoked: mutates the shared counter and writes reporter output.
 * function record(config: Config, details: TestDetails) {
 *   Reporter.testEnd(config, details); // counter first, then every reporter sees the same totals
 * }
 * ```
 */
export function testEnd(config: Config, details: TestDetails): void {
  updateCounter(config.state.results.counter, details);
  fanOut(config, 'onTestEnd', (reporter) => reporter.onTestEnd?.(config, details));
}

/**
 * Emits run end to every active reporter, awaiting any that flush asynchronously.
 *
 * ```ts
 * import * as Reporter from './index.ts';
 *
 * import type { Config } from '../types.ts';
 * import type { RunEndInfo } from './types.ts';
 *
 * // Defined, not invoked: JUnit flushes its XML file here.
 * async function finish(config: Config, info: RunEndInfo) {
 *   await Reporter.runEnd(config, info);
 * }
 * ```
 */
export async function runEnd(config: Config, info: RunEndInfo): Promise<void> {
  for (const reporter of config.state.reporters) {
    // Awaited one at a time, and isolated the same way the sync hooks are: JUnit writes a file
    // here, and a third-party reporter that rejects must not cost the run its artifacts.
    try {
      await reporter.onRunEnd?.(config, info);
    } catch (error) {
      reportReporterFailure(config, 'onRunEnd', error);
    }
  }
}

/**
 * Emits one of qunitx's own diagnostics: renders it to the run's output as a TAP `#` comment,
 * then hands the structured form to any reporter that wants it.
 *
 * Both halves matter. The rendering is what every `console.log('#', …)` scattered through the
 * run pipeline used to do inline — which meant a run could not be made quiet, and a caller
 * could not read the diagnostics back. Going through here, silence is a matter of the run's
 * `output`, and capture is a matter of a reporter.
 *
 * ```ts
 * import * as Reporter from './index.ts';
 *
 * import type { Config } from '../types.ts';
 *
 * // Defined, not invoked: writes '# No tests matched …' to the run's output.
 * function warnNoMatches(config: Config, filter: string) {
 *   Reporter.notice(config, { level: 'warning', message: `No tests matched ${filter}` });
 * }
 * ```
 */
export function notice(config: Config, notice: Notice): void {
  const line = notice.raw ? notice.message : `# ${notice.message}\n`;
  const stream = notice.stream ?? 'output';
  if (stream !== 'error') config.state.output.write(line);
  if (stream !== 'output') config.state.output.error(line);
  fanOut(config, 'onNotice', (reporter) => reporter.onNotice?.(config, notice));
}

/**
 * Emits one `console.*` call or uncaught error from the page under test. Rendered verbatim —
 * no `#` prefix — because it is the page's output, not qunitx's, and prefixing it would corrupt
 * whatever the page was deliberately printing.
 *
 * ```ts
 * import * as Reporter from './index.ts';
 *
 * import type { Config } from '../types.ts';
 *
 * // Defined, not invoked: writes the page's own line to the run's output.
 * function forward(config: Config) {
 *   Reporter.browserLog(config, { type: 'error', text: 'boom', args: [] });
 * }
 * ```
 */
export function browserLog(config: Config, log: BrowserLog): void {
  const line = `${log.text}\n`;
  // Matches what the page-event handlers did directly: console.log for everything, console.error
  // for an uncaught pageerror, so a crashed page is visible in a stdout-only or stderr-only log.
  if (log.type === 'pageerror') config.state.output.error(line);
  else config.state.output.write(line);
  fanOut(config, 'onBrowserLog', (reporter) => reporter.onBrowserLog?.(config, log));
}

/**
 * Delivers one event to every reporter, isolating each from the others.
 *
 * `Reporter` is public surface, so a reporter is third-party code, and a plain `forEach` gives
 * the first one that throws the power to stop delivery to the rest — including the collector the
 * JS API builds its result from, and the counter reconciliation that depends on it. A reporter
 * that throws should cost its own output and nothing else.
 */
function fanOut(config: Config, hook: string, deliver: (reporter: Reporter) => void): void {
  for (const reporter of config.state.reporters) {
    try {
      deliver(reporter);
    } catch (error) {
      reportReporterFailure(config, hook, error);
    }
  }
}

/**
 * Reports a throwing reporter straight to the output rather than through `notice` — a reporter
 * that throws from `onNotice` would otherwise be handed the notice about itself, and throw again.
 */
function reportReporterFailure(config: Config, hook: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  config.state.output.error(`# [qunitx] reporter ${hook} threw: ${message}\n`);
}

// Exactly one stdout reporter per run. `--reporter` is validated in Args.parse, so an
// unknown value never reaches here; tap is the default and the fallback.
function stdoutReporter(config: Config): Reporter {
  return new (STDOUT_REPORTERS[config.reporter ?? 'tap'] ?? TAPReporter)();
}
