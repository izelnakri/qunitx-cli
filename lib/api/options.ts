import { DotReporter } from '../reporters/dot.ts';
import { GithubReporter } from '../reporters/github.ts';
import { JUnitReporter } from '../reporters/junit.ts';
import { SpecReporter } from '../reporters/spec.ts';
import { TAPReporter } from '../reporters/tap.ts';
import { processOutput, silentOutput, streamOutput, type Output } from '../reporters/output.ts';
import { Collector, toTestResult } from './result.ts';
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
  'reporter' | 'plugins' | 'onTest' | 'onNotice' | 'onBrowserLog' | 'open'
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
 * Silence unless something is going to be printed. A reporter with nowhere to write would be a
 * confusing no-op, and a `stdout` with no reporter would still carry the `#` diagnostics — which
 * is a legitimate thing to want, so both independently opt in.
 */
function resolveOutput(options: RunOptions): Output {
  if (options.stdout) {
    return streamOutput(options.stdout, options.stderr ?? options.stdout);
  } else if (options.stderr) {
    return streamOutput(process.stdout, options.stderr);
  } else if (options.reporter) {
    return processOutput;
  }

  return silentOutput;
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
