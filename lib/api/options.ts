import { JUnitReporter } from '../reporters/junit.ts';
import { BUILT_IN_REPORTERS } from '../reporters/index.ts';
import { processConsole, silentConsole, type Console } from '../console.ts';
import { APIReporter } from './reporter.ts';
import { REPORTERS } from '../reporters/types.ts';
import { Failure } from '../task/index.ts';
import type { Reporter, ReporterName } from '../reporters/types.ts';
import type { ConfigOptions } from '../setup/config.ts';
import type { Plugin as EsbuildPlugin } from 'esbuild';

/** `--reporter` by name, a reporter of your own, or `false` for none. */
export type ReporterOption = ReporterName | Reporter | false;

/**
 * Everything a run can be told to do. Every field is optional: `run()` with no arguments runs
 * the project exactly as a bare `qunitx` would, minus the printing.
 *
 * Two things differ from the command line, both because they cannot be typed into a shell:
 * `plugins` takes live esbuild plugin objects, and `cwd` picks the project.
 *
 * ```ts
 * const options: UserRunOptions = { inputs: ['test/'], filter: 'Cart', coverage: true };
 * options.reporter; // undefined — nothing is printed unless you ask for it
 * ```
 */
export interface UserRunOptions {
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
   * Print the run with ONE reporter: a built-in name (`'tap'`, `'spec'`, `'dot'`, `'github'`),
   * your own {@link Reporter}, or `false`. The same spelling as the CLI's `--reporter`.
   *
   * **Omitted means nothing is printed** — the result value is the output.
   */
  reporter?: ReporterOption;
  /**
   * Print the run with SEVERAL. Mutually exclusive with {@link UserRunOptions.reporter}: pass
   * `reporter` for one, `reporters` for many, and {@link validate} rejects both at once.
   */
  reporters?: ReadonlyArray<ReporterOption>;
  /**
   * Where the run's text goes. Defaults to the process streams when a reporter is NAMED, and to
   * {@link silentConsole} otherwise — so a programmatic run prints nothing unless it was asked to.
   *
   * Set it to capture the built-in reporters' output, which is the only way to reach it:
   * `console: streamConsole(myBuffer)`.
   */
  console?: Console;
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
export function validate(userRunOptions: UserRunOptions): void {
  if (userRunOptions.browser !== undefined && !BROWSERS.includes(userRunOptions.browser)) {
    throw InvalidOption({
      option: 'browser',
      value: userRunOptions.browser,
      expected: `one of ${BROWSERS.join(', ')}`,
    });
  }
  if (userRunOptions.reporter !== undefined && userRunOptions.reporters !== undefined) {
    throw InvalidOption({
      option: 'reporters',
      value: userRunOptions.reporters,
      expected: '`reporter` for one reporter or `reporters` for several, not both',
    });
  }
  for (const entry of getReportersOf(userRunOptions)) {
    if (typeof entry === 'string' && !(REPORTERS as readonly string[]).includes(entry)) {
      throw InvalidOption({
        option: 'reporter',
        value: entry,
        expected: `one of ${REPORTERS.join(', ')}, a Reporter object, or false`,
      });
    }
  }
  const formats =
    typeof userRunOptions.coverage === 'object' ? (userRunOptions.coverage.formats ?? []) : [];
  for (const format of formats) {
    if (!COVERAGE_FORMATS.includes(format)) {
      throw InvalidOption({
        option: 'coverage.formats',
        value: format,
        expected: `one of ${COVERAGE_FORMATS.join(', ')}`,
      });
    }
  }
  const port = userRunOptions.port;
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535)) {
    throw InvalidOption({ option: 'port', value: port, expected: 'an integer 0-65535' });
  }
  if (
    userRunOptions.timeout !== undefined &&
    !(Number.isFinite(userRunOptions.timeout) && userRunOptions.timeout > 0)
  ) {
    throw InvalidOption({
      option: 'timeout',
      value: userRunOptions.timeout,
      expected: 'a positive number of milliseconds',
    });
  }
}

/**
 * The reporters asked for, however they were spelled — `reporter` for one, `reporters` for many.
 * {@link validate} has already refused both at once, so reading them in this order is total.
 */
function getReportersOf(userRunOptions: UserRunOptions): ReadonlyArray<ReporterOption | undefined> {
  return userRunOptions.reporters ?? [userRunOptions.reporter];
}

/**
 * Public options in, runner input out — this is the API's `Args.parse`, and the only reason
 * {@link UserRunOptions} and `ConfigOptions` are separate types.
 *
 * Takes the same shorthands every verb does: a single path, a list of paths, or the options
 * object, so `run('test/')` and `run({ inputs: ['test/'] })` reach here identically.
 *
 * `ConfigOptions` extends the CLI's parsed flags, so its shape is the flag grammar's: `htmlPaths`,
 * `coverageFormats`, `portExplicit`. Publishing that would make every flag rename a breaking API
 * change and would expose `portExplicit`, which only exists to record whether the user typed
 * `--port`. This is where the two vocabularies meet, and it is the only place that knows both.
 *
 * The returned `reporters` is a fresh array, and typed as always present, so a caller with a
 * reporter of its own can push onto it before handing the whole thing to `Config.setup`.
 *
 * ```ts
 * import * as Options from './options.ts';
 *
 * Options.from('test/cart-test.ts').inputs; // ['test/cart-test.ts'] — the bare-path shorthand
 * Options.from({ coverage: { formats: ['lcov'] } }).coverageFormats; // ['lcov']
 * Options.from({ html: ['test/index.html'] }).htmlPaths; // ['test/index.html']
 * ```
 */
export function from(
  input: UserRunOptions | string | string[] = {},
  options?: UserRunOptions,
): ConfigOptions & { reporters: Reporter[] } {
  const userRunOptions = toUserOptions(input, options);
  validate(userRunOptions);
  const coverage = userRunOptions.coverage;
  const requestedReporters = getReportersOf(userRunOptions);
  // Recorder, then whatever was asked for, then artifacts — JUnit is additive rather than a choice
  // of format, exactly as `--junit` is. Delivery isolates each reporter, so the order is not
  // load-bearing; it just puts the run's own bookkeeping ahead of a caller's.
  const reporters: Reporter[] = [new APIReporter()];
  for (const entry of requestedReporters) {
    if (entry) reporters.push(typeof entry === 'string' ? new BUILT_IN_REPORTERS[entry]() : entry);
  }
  if (userRunOptions.junit) reporters.push(new JUnitReporter());

  return {
    inputs: userRunOptions.inputs,
    cwd: userRunOptions.cwd,
    filter: userRunOptions.filter,
    browser: userRunOptions.browser,
    timeout: userRunOptions.timeout,
    failFast: userRunOptions.failFast,
    onlyFailed: userRunOptions.onlyFailed,
    changedSince: userRunOptions.changedSince,
    coverage: coverage === undefined ? undefined : Boolean(coverage),
    coverageFormats: typeof coverage === 'object' ? (coverage.formats ?? []) : undefined,
    junit: userRunOptions.junit,
    output: userRunOptions.output,
    port: userRunOptions.port,
    // An explicitly requested port must not silently slide to the next free one — the caller
    // picked it because something else is about to connect there.
    portExplicit: userRunOptions.port === undefined ? undefined : true,
    extensions: userRunOptions.extensions,
    htmlPaths: userRunOptions.html,
    before: userRunOptions.before,
    after: userRunOptions.after,
    debug: userRunOptions.debug,
    open: userRunOptions.open,
    esbuildPlugins: userRunOptions.plugins,
    signal: userRunOptions.signal,
    reporters,
    // A reporter NAME asks for the CLI's text; a reporter OBJECT is a request to observe, not to
    // print, so it stays silent. A `console` of your own wins either way.
    console:
      userRunOptions.console ??
      (requestedReporters.some((entry) => typeof entry === 'string')
        ? processConsole
        : silentConsole),
  };
}

/**
 * Normalises the three call shapes into the object one, without translating anything else.
 *
 * `from` turns user options into the config's shape; this only collapses `'test/'` and
 * `['a.ts', 'b.ts']` into `{ inputs }`, so a caller that needs to MERGE two sets of user options —
 * a watch session applying a restart patch — can do it before that translation rather than after.
 *
 * ```ts
 * import { toUserOptions } from './options.ts';
 *
 * toUserOptions('test/'); // { inputs: ['test/'] }
 * toUserOptions('test/', { filter: 'Cart' }); // { filter: 'Cart', inputs: ['test/'] }
 * toUserOptions({ filter: 'Cart' }).filter; // 'Cart'
 * ```
 */
export function toUserOptions(
  input: UserRunOptions | string | string[] = {},
  options?: UserRunOptions,
): UserRunOptions {
  if (typeof input === 'string' || Array.isArray(input)) {
    // The target wins over any `inputs` in the options object: naming it positionally is the more
    // specific statement, and silently preferring the other one would be a selection the caller
    // did not ask for.
    return { ...options, inputs: [input].flat() };
  }

  return input;
}
