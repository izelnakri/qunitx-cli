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
import type { ReporterContext } from './types.ts';

// One context per config, not per event: 10k tests would otherwise allocate 10k of them. Keyed by
// config so a concurrent group gets its own — the group spread hands each one its own `state`.
const CONTEXTS = new WeakMap<Config, ReporterContext>();

/**
 * The read-only view a reporter is handed, built once per config.
 *
 * `counts` and `sourceMapDecoder` read through rather than being copied: the counter object is
 * mutated in place by the runner, and the decoder is attached partway through a run.
 */
function contextOf(config: Config): ReporterContext {
  let context = CONTEXTS.get(config);
  if (!context) {
    context = {
      get console() {
        return config.state.console;
      },
      get counts() {
        return config.state.results.counter;
      },
      get sourceMapDecoder() {
        return config.state.group.sourceMapDecoder;
      },
      get daemon() {
        return config.state.daemon !== null;
      },
      projectRoot: config.projectRoot,
      output: config.output,
      junit: config.junit,
    };
    CONTEXTS.set(config, context);
  }

  return context;
}

/**
 * The `--reporter` value -> its class. Keyed by `ReporterName`, so adding a name to `REPORTERS`
 * without wiring it up here is a type error rather than a silent fall back to tap.
 *
 * Exported because the JS API instantiates the same four by name; a second copy of this table
 * would mean a new reporter worked from the CLI and not from `run({ reporter: … })`.
 *
 * ```ts
 * new BUILT_IN_REPORTERS.tap(); // the same instance `--reporter=tap` builds
 * ```
 */
export const BUILT_IN_REPORTERS: Record<ReporterName, new () => Reporter> = {
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
  for (const reporter of config.state.reporters) {
    try {
      reporter.onRunStart?.(contextOf(config), info);
    } catch (error) {
      reporterThrew(config, 'onRunStart', error);
    }
  }
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
  for (const reporter of config.state.reporters) {
    try {
      reporter.onTestEnd?.(contextOf(config), details);
    } catch (error) {
      reporterThrew(config, 'onTestEnd', error);
    }
  }
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
      await reporter.onRunEnd?.(contextOf(config), info);
    } catch (error) {
      reporterThrew(config, 'onRunEnd', error);
    }
  }
}

/**
 * Options a diagnostic can carry beyond its text. Both default to the CLI's long-standing
 * behaviour, so only the handful of call sites that need something else say so.
 */
export interface NoticeOptions {
  /**
   * Write the message verbatim rather than as a `# `-prefixed TAP comment. For pre-formatted
   * blocks — the coverage table, a stack trace — whose own layout is the point.
   */
  raw?: boolean;
  /** Which of the run's two streams the default rendering goes to. `output` by default. */
  stream?: 'output' | 'error' | 'both';
}

/**
 * A decision the runner made and wants on the record — what it chose to run, what it skipped.
 *
 * ```ts
 * import * as Reporter from './index.ts';
 *
 * import type { Config } from '../types.ts';
 *
 * // Defined, not invoked: writes '# scoped to 2 files' to the run's sink.
 * function announce(config: Config) {
 *   Reporter.info(config, 'scoped to 2 files');
 * }
 * ```
 */
export function info(config: Config, message: string, options: NoticeOptions = {}): void {
  emit(config, { level: 'info', message, ...options });
}

/**
 * Something surprising that did not stop the run — a filter that matched nothing, a flag that
 * does not apply to the chosen browser.
 *
 * ```ts
 * import * as Reporter from './index.ts';
 *
 * import type { Config } from '../types.ts';
 *
 * // Defined, not invoked: writes '# No tests matched Cart' to the run's sink.
 * function warnNoMatches(config: Config, filter: string) {
 *   Reporter.warning(config, `No tests matched ${filter}`);
 * }
 * ```
 */
export function warning(config: Config, message: string, options: NoticeOptions = {}): void {
  emit(config, { level: 'warning', message, ...options });
}

/**
 * A diagnostic that also belongs on stderr — a stack trace, a timeout, a page that crashed.
 *
 * ```ts
 * import * as Reporter from './index.ts';
 *
 * import type { Config } from '../types.ts';
 *
 * // Defined, not invoked: writes the trace to the run's error stream, unprefixed.
 * function reportCrash(config: Config, stack: string) {
 *   Reporter.error(config, stack, { raw: true, stream: 'error' });
 * }
 * ```
 */
export function error(config: Config, message: string, options: NoticeOptions = {}): void {
  emit(config, { level: 'error', message, ...options });
}

/**
 * Renders one diagnostic to the run's sink, then hands the structured form to every reporter.
 *
 * Both halves matter. The rendering is what every `console.log('#', …)` scattered through the run
 * pipeline used to do inline — which meant a run could not be made quiet, and a caller could not
 * read the diagnostics back. Going through here, silence is a matter of the run's `sink` and
 * capture is a matter of a reporter.
 */
function emit(config: Config, notice: Notice): void {
  const line = notice.raw ? notice.message : `# ${notice.message}\n`;
  const stream = notice.stream ?? 'output';
  if (stream !== 'error') config.state.console.log(line);
  if (stream !== 'output') config.state.console.error(line);

  for (const reporter of config.state.reporters) {
    try {
      reporter.onNotice?.(contextOf(config), notice);
    } catch (caught) {
      reporterThrew(config, 'onNotice', caught);
    }
  }
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
  if (log.type === 'pageerror') config.state.console.error(line);
  else config.state.console.log(line);
  for (const reporter of config.state.reporters) {
    try {
      reporter.onBrowserLog?.(contextOf(config), log);
    } catch (error) {
      reporterThrew(config, 'onBrowserLog', error);
    }
  }
}

/**
 * Reports a throwing reporter straight to the sink rather than through `notice` — a reporter that
 * throws from `onNotice` would otherwise be handed the notice about itself, and throw again.
 *
 * Every emitter above delivers in its own `for`/`try` rather than through a shared fan-out
 * helper. `Reporter` is public surface, so a reporter is third-party code and one that throws
 * must cost only its own output — and the loop that guarantees that is worth seeing at each of
 * the five places it happens, especially since `onRunEnd` awaits and cannot share them anyway.
 */
function reporterThrew(config: Config, hook: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  config.state.console.error(`# [qunitx] reporter ${hook} threw: ${message}\n`);
}

// Exactly one stdout reporter per run. `--reporter` is validated in Args.parse, so an
// unknown value never reaches here; tap is the default and the fallback.
function stdoutReporter(config: Config): Reporter {
  return new (BUILT_IN_REPORTERS[config.reporter ?? 'tap'] ?? TAPReporter)();
}
