import { DotReporter } from '../reporters/dot.ts';
import { GithubReporter } from '../reporters/github.ts';
import { JUnitReporter } from '../reporters/junit.ts';
import { SpecReporter } from '../reporters/spec.ts';
import { TAPReporter } from '../reporters/tap.ts';
import { processOutput, silentOutput, streamOutput, type Output } from '../reporters/output.ts';
import { Collector, toTestResult } from './result.ts';
import { REPORTERS } from '../reporters/types.ts';
import { Failure } from '../task/index.ts';
import type { BrowserLog, Notice, Reporter, ReporterName } from '../reporters/types.ts';
import type { TestResult } from './result.ts';
import type { ConfigOptions } from '../setup/config.ts';
import type { Plugin as EsbuildPlugin } from 'esbuild';

/** `--reporter` by name, a reporter of your own, or `false` for none. */
export type ReporterOption = ReporterName | Reporter | false;

/** Anything that can take a chunk of text — a `node:fs` write stream, a socket, a fake. */
export interface WritableLike {
  /** Called with each chunk. The return value is ignored. */
  write(text: string): unknown;
}

/**
 * Everything a run can be told to do. Every field is optional: `run()` with no arguments runs
 * the project exactly as a bare `qunitx` would, minus the printing.
 *
 * Two things differ from the command line, both because they cannot be typed into a shell:
 * `plugins` takes live esbuild plugin objects, and `cwd` picks the project.
 *
 * ```ts
 * const options: RunOptions = { inputs: ['test/'], filter: 'Cart', coverage: true };
 * options.reporter; // undefined — nothing is printed unless you ask for it
 * ```
 */
export interface RunOptions {
  /**
   * Files, directories, globs, or `file.ts#34` line targets — the same grammar as the
   * command line's positional arguments. Defaults to `package.json#qunitx.inputs`.
   */
  inputs?: string[];
  /** Directory the project root and relative inputs resolve against. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Run only tests whose `"Module: test name"` matches. QUnit's own semantics: case-insensitive
   * substring, `/regex/`, `/regex/i`, or a leading `!` to invert.
   */
  filter?: string;
  /** Browser engine. Defaults to `chromium`, the only one that can collect coverage. */
  browser?: 'chromium' | 'firefox' | 'webkit';
  /** Milliseconds a single test may take before the run is declared stalled. Defaults to 20000. */
  timeout?: number;
  /** Stop the run at the first failing test. */
  failFast?: boolean;
  /** Run only the files that failed last time, from the persistent failure cache. */
  onlyFailed?: boolean;
  /** Run only files whose transitive imports changed since this git ref (`'HEAD'` for uncommitted). */
  changedSince?: string;
  /** Collect V8 line coverage (chromium only). `formats` additionally writes lcov/html artifacts. */
  coverage?: boolean | { formats?: Array<'lcov' | 'html'> };
  /** Write a JUnit XML report. `true` writes `<output>/junit.xml`; a string is a path. */
  junit?: boolean | string;
  /**
   * Print the run. A built-in name (`'tap'`, `'spec'`, `'dot'`, `'github'`), your own
   * {@link Reporter}, an array of either, or `false`. **Omitted means nothing is printed** —
   * the result value is the output.
   */
  reporter?: ReporterOption | ReadonlyArray<ReporterOption>;
  /** Where a reporter writes. Defaults to `process.stdout` when a reporter is set. */
  stdout?: WritableLike;
  /** Where error-level output goes. Defaults to `stdout` when that is set, else `process.stderr`. */
  stderr?: WritableLike;
  /** Called as each test finishes — the streaming half of `result.tests`. */
  onTest?: (test: TestResult) => void;
  /** Called for each of qunitx's own diagnostics. */
  onNotice?: (notice: Notice) => void;
  /** Called for each `console.*` call and uncaught error from the page. */
  onBrowserLog?: (log: BrowserLog) => void;
  /** Directory for the compiled bundle and HTML output. Defaults to `'tmp'`. */
  output?: string;
  /** Port for the local test server. Defaults to 1234, incrementing on conflict. */
  port?: number;
  /** File extensions treated as test files. Defaults to `['js', 'ts', 'jsx', 'tsx']`. */
  extensions?: string[];
  /** HTML fixture files to wrap the bundle in, relative to the project root. */
  html?: string[];
  /** Path to a module run before the tests; it receives the resolved config. */
  before?: string | false;
  /** Path to a module run after the tests; it receives the run's counters. */
  after?: string | false;
  /** esbuild plugins for the test bundle — live objects, not specifiers. */
  plugins?: EsbuildPlugin[];
  /** Forward every page console call and print the server URL. */
  debug?: boolean;
  /** Open the output in a browser: `true` for the default, a string to name a binary. */
  open?: boolean | string;
  /**
   * Cancels the run when it fires.
   *
   * Cancellation here means "stop and answer", not "throw": the browser drops the rest of its
   * queue and the run resolves with whatever it had, marked `aborted: true`. The tests that did
   * finish are still on the result, which is the point — a cancelled run that discarded its own
   * findings would be no more useful than one that never started.
   *
   * An already-aborted signal short-circuits: no browser is launched at all.
   */
  signal?: AbortSignal;
}

/**
 * The options a daemon run accepts: everything from {@link RunOptions} that survives a socket.
 *
 * A daemon run happens in another process, so a plugin object, a reporter instance, a callback
 * and a `plugins` array cannot come along — they are functions, and functions do not serialize.
 * Rather than accepting them and silently dropping them, they are simply not in this type: the
 * limitation is a compile error at the call site instead of a surprise at run time.
 *
 * `reporter` narrows to the built-in names for the same reason. `stdout`/`stderr` stay, because
 * they are the *client's* sinks for the text the daemon streams back — they never cross.
 *
 * ```ts
 * const options: DaemonRunOptions = { inputs: ['test/'], reporter: 'tap' };
 * options.reporter; // 'tap' — a name, not an instance
 * ```
 */
export interface DaemonRunOptions extends Omit<
  RunOptions,
  'reporter' | 'plugins' | 'onTest' | 'onNotice' | 'onBrowserLog' | 'open' | 'signal'
> {
  /** A built-in reporter's name, several of them, or `false`. Instances cannot cross a socket. */
  reporter?: ReporterName | ReadonlyArray<ReporterName> | false;
}

/**
 * The reporters and output a set of options resolves to, plus the collector that will observe
 * the run either way.
 */
export interface ResolvedReporting {
  /** What to hand `Config.setup` as `reporters`. Always ends with the collector. */
  reporters: Reporter[];
  /** Where those reporters write. */
  output: Output;
  /** The collector the result is built from. */
  collector: Collector;
}

/**
 * An option was given a value the runner will not accept.
 *
 * The API's equivalent of `InvalidFlag`, and it exists for the same reason: the values that come
 * from outside — an enum spelled wrong, a port out of range — must be rejected where they are
 * named, not several layers down as an unexplained browser-launch failure.
 *
 * ```ts
 * const failure = InvalidOption({ option: 'browser', value: 'netscape', expected: 'chromium, firefox, webkit' });
 * failure.data.option; // 'browser' — typed payload, no message parsing
 * ```
 */
export const InvalidOption: Failure.FailureFactory<
  'InvalidOption',
  { option: string; value: unknown; expected: string }
> = Failure.define(
  'InvalidOption',
  (data: { option: string; value: unknown; expected: string }) =>
    `Invalid \`${data.option}\` value: ${JSON.stringify(data.value) ?? String(data.value)}. Expected ${data.expected}.`,
);

/** The one failure {@link validate} raises. */
export type InvalidOptionFailure = Failure.Of<typeof InvalidOption>;

const BROWSERS = ['chromium', 'firefox', 'webkit'];
const COVERAGE_FORMATS = ['lcov', 'html'];

/**
 * Rejects options the run cannot honour, before anything is launched.
 *
 * Only the closed sets and the bounded numbers are checked here — the same ones `Args.parse`
 * validates for argv. Everything else is either free-form (a filter, a path) or already a
 * compile-time error for a TypeScript caller; this is the guard for the ones that are neither,
 * which is exactly what a JavaScript caller or a generated call can get wrong.
 *
 * ```ts
 * import { validate, InvalidOption } from './options.ts';
 *
 * try {
 *   validate({ browser: 'netscape' as 'chromium' });
 * } catch (error) {
 *   InvalidOption.is(error); // true
 * }
 * ```
 */
export function validate(options: RunOptions): void {
  if (options.browser !== undefined && !BROWSERS.includes(options.browser)) {
    throw InvalidOption({
      option: 'browser',
      value: options.browser,
      expected: `one of ${BROWSERS.join(', ')}`,
    });
  }
  for (const entry of Array.isArray(options.reporter) ? options.reporter : [options.reporter]) {
    if (typeof entry === 'string' && !(REPORTERS as readonly string[]).includes(entry)) {
      throw InvalidOption({
        option: 'reporter',
        value: entry,
        expected: `one of ${REPORTERS.join(', ')}, a Reporter object, or false`,
      });
    }
  }
  const formats = typeof options.coverage === 'object' ? (options.coverage.formats ?? []) : [];
  for (const format of formats) {
    if (!COVERAGE_FORMATS.includes(format)) {
      throw InvalidOption({
        option: 'coverage.formats',
        value: format,
        expected: `one of ${COVERAGE_FORMATS.join(', ')}`,
      });
    }
  }
  if (options.port !== undefined && !isPort(options.port)) {
    throw InvalidOption({ option: 'port', value: options.port, expected: 'an integer 0-65535' });
  }
  if (options.timeout !== undefined && !(Number.isFinite(options.timeout) && options.timeout > 0)) {
    throw InvalidOption({
      option: 'timeout',
      value: options.timeout,
      expected: 'a positive number of milliseconds',
    });
  }
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 65535;
}

/**
 * Accepts the shorthands: a single path, a list of paths, or the full options object. So
 * `run('test/')` and `run({ inputs: ['test/'] })` are the same call.
 *
 * ```ts
 * normalizeOptions('test/cart-test.ts').inputs; // ['test/cart-test.ts']
 * normalizeOptions(['a.ts', 'b.ts']).inputs; // ['a.ts', 'b.ts']
 * normalizeOptions({ filter: 'Cart' }).filter; // 'Cart'
 * ```
 */
export function normalizeOptions(options: RunOptions | string | string[] = {}): RunOptions {
  if (typeof options === 'string') return { inputs: [options] };
  if (Array.isArray(options)) return { inputs: options };

  return options;
}

/**
 * Builds the run's reporter set and output stream.
 *
 * The default is silence: with no `reporter`, nothing is printed and the run's diagnostics exist
 * only as data on the result. Naming one opts back into text, and `stdout` says where it goes.
 *
 * ```ts
 * resolveReporting({}).reporters.length; // 1 — the collector, which prints nothing
 * resolveReporting({ reporter: 'tap' }).reporters.length; // 2 — the collector, then TAP
 * ```
 */
export function resolveReporting(options: RunOptions): ResolvedReporting {
  const collector = new Collector();
  const requested = (Array.isArray(options.reporter) ? options.reporter : [options.reporter])
    .filter((entry): entry is ReporterName | Reporter => Boolean(entry))
    .map(instantiate);
  // The JUnit reporter is additive rather than a choice of format, exactly as `--junit` is.
  if (options.junit) requested.push(new JUnitReporter());
  const callbacks = callbackReporter(options);
  if (callbacks) requested.push(callbacks);

  return {
    // Collector FIRST: the fan-out in `Reporter.testEnd` is a plain forEach, so a reporter that
    // throws stops the ones after it. Recording before printing means a broken custom reporter
    // costs the caller some output, never the result.
    reporters: [collector, ...requested],
    output: resolveOutput(options),
    collector,
  };
}

/**
 * Translates public options into the internal {@link ConfigOptions}. The two are deliberately
 * separate types: the public one is stable, ergonomic, and free to disagree with the flag names
 * (`html` rather than `htmlPaths`, `coverage: { formats }` rather than two parallel fields).
 *
 * ```ts
 * const reporting = resolveReporting({});
 * toConfigOptions({ coverage: { formats: ['lcov'] } }, reporting).coverageFormats; // ['lcov']
 * toConfigOptions({ html: ['test/index.html'] }, reporting).htmlPaths; // ['test/index.html']
 * ```
 */
export function toConfigOptions(options: RunOptions, reporting: ResolvedReporting): ConfigOptions {
  const coverage = options.coverage;

  // `withoutUndefined` is load-bearing, not tidiness: `Config.setup` merges these over
  // `package.json#qunitx` with a spread, and a key present-but-undefined overwrites the
  // package.json value with nothing. An option the caller did not set must not silently
  // un-set the project's own configuration.
  return withoutUndefined({
    inputs: options.inputs,
    cwd: options.cwd,
    filter: options.filter,
    browser: options.browser,
    timeout: options.timeout,
    failFast: options.failFast,
    onlyFailed: options.onlyFailed,
    changedSince: options.changedSince,
    coverage: coverage === undefined ? undefined : Boolean(coverage),
    coverageFormats: typeof coverage === 'object' ? (coverage.formats ?? []) : undefined,
    junit: options.junit,
    output: options.output,
    port: options.port,
    // An explicitly requested port must not silently slide to the next free one — the caller
    // picked it because something else is about to connect there.
    portExplicit: options.port === undefined ? undefined : true,
    extensions: options.extensions,
    htmlPaths: options.html,
    before: options.before,
    after: options.after,
    debug: options.debug,
    open: options.open,
    esbuildPlugins: options.plugins,
    reporters: reporting.reporters,
    reporterOutput: reporting.output,
  });
}

/** Drops keys whose value is `undefined`, so a spread over defaults leaves them alone. */
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

const BUILT_IN: Record<ReporterName, new () => Reporter> = {
  tap: TAPReporter,
  spec: SpecReporter,
  dot: DotReporter,
  github: GithubReporter,
};

function instantiate(entry: ReporterName | Reporter): Reporter {
  return typeof entry === 'string' ? new BUILT_IN[entry]() : entry;
}

/**
 * Silence unless something is going to be printed.
 *
 * A *named* reporter is a request for the CLI's text, so it defaults to the process streams. A
 * reporter **object** is not: it is a request to observe the run programmatically, and turning on
 * the host's stdout because someone passed a collector would break the silent-by-default promise
 * in the exact case they were being careful. Naming `stdout`/`stderr` opts in either way — and
 * does so even with no reporter at all, which is how you get just the `#` diagnostics.
 */
function resolveOutput(options: RunOptions): Output {
  if (options.stdout) {
    return streamOutput(options.stdout, options.stderr ?? options.stdout);
  } else if (options.stderr) {
    return streamOutput(process.stdout, options.stderr);
  }
  const requested = Array.isArray(options.reporter) ? options.reporter : [options.reporter];

  return requested.some((entry) => typeof entry === 'string') ? processOutput : silentOutput;
}

/** Wraps the three convenience callbacks into one reporter, or nothing when none were given. */
function callbackReporter(options: RunOptions): Reporter | null {
  const { onTest, onNotice, onBrowserLog } = options;
  if (!onTest && !onNotice && !onBrowserLog) return null;

  return {
    onTestEnd: onTest && ((_config, details) => onTest(toTestResult(details))),
    onNotice: onNotice && ((_config, notice) => onNotice(notice)),
    onBrowserLog: onBrowserLog && ((_config, log) => onBrowserLog(log)),
  };
}
