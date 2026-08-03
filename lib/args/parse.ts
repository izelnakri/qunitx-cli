import path from 'node:path';
import { tokenize, type QueryToken } from './tokenize.ts';
import { REPORTERS, type ReporterName } from '../reporters/types.ts';
import { type Result, Failure } from '../result/index.ts';

/**
 * A flag was given a value this parser will not accept.
 *
 * Reported rather than exited on. Parsing argv is a pure transform, and the seven
 * `console.error` + `process.exit(1)` pairs this replaces made it impossible to call from
 * anywhere that must survive bad input: the daemon parses argv once per request and would
 * have taken the whole daemon down with it, and the unit tests had to monkeypatch
 * `process.exit` into throwing a Symbol to observe any of these branches at all.
 *
 * `cli.ts` is now the single place that turns one of these into a message and an exit code.
 *
 * ```ts
 * import * as Args from './index.ts';
 *
 * const failure = Args.InvalidFlag({ flag: '--port', value: 'abc', expected: 'Expected --port=<0-65535>.' });
 * failure.message; // 'Invalid --port value: "abc". Expected --port=<0-65535>.'
 * failure.data.flag; // '--port' — typed payload, no message parsing
 * ```
 */
export const InvalidFlag = Failure.define(
  'InvalidFlag',
  (data: { flag: string; value: string; expected: string }) =>
    `Invalid ${data.flag} value: "${data.value}". ${data.expected}`,
);

/**
 * Every way `parse()` can reject its input.
 *
 * ```ts
 * import * as Args from './index.ts';
 *
 * const failure: Args.ParseFailure = Args.InvalidFlag({ flag: '--browser', value: 'ie', expected: 'No.' });
 * failure.code; // 'InvalidFlag' — the only parse failure kind today
 * ```
 */
export type ParseFailure = Failure.Of<typeof InvalidFlag>;

const BROWSERS = ['chromium', 'firefox', 'webkit'];
const COVERAGE_FORMATS = ['text', 'lcov', 'html'];

// Fallback when --timeout is passed with an unparseable or zero value.
const FALLBACK_TIMEOUT_MS = 10_000;

// Default discovery extensions, duplicated from defaultProjectConfigValues so the swallowed-target
// hint can run at parse time (config, which owns the real list, is built from these flags).
const FILE_LOOKING = /\.(js|ts|jsx|tsx|html)$/;

/**
 * The flag object a successful `parse()` carries — CLI flags only, before package.json merge.
 *
 * ```ts
 * import * as Args from './index.ts';
 *
 * // Defined, not invoked: the shape is what parse(projectRoot) yields on the success branch.
 * function flagsOf(projectRoot: string) {
 *   const parsed = Args.parse(projectRoot);
 *   return Args.InvalidFlag.is(parsed) ? null : { inputs: parsed.inputs, watch: parsed.watch };
 * }
 * ```
 */
// { inputs: [], debug: true, watch: true, open: true, failFast: true, onlyFailed: true, htmlPaths: [], output }
export interface ParsedFlags {
  inputs: string[];
  debug?: boolean;
  watch?: boolean;
  open?: boolean | string;
  failFast?: boolean;
  onlyFailed?: boolean;
  timeout?: number;
  output?: string;
  htmlPaths?: string[];
  port?: number;
  portExplicit?: boolean;
  extensions?: string[];
  browser?: 'chromium' | 'firefox' | 'webkit';
  before?: string | false;
  after?: string | false;
  changedSince?: string;
  reporter?: ReporterName;
  junit?: boolean | string;
  coverage?: boolean;
  coverageFormats?: string[];
  filter?: string;
  /** `--search`/`--print` mode: the expression to preview, or `true` to list everything. */
  search?: string | true;
  lineTargets?: Record<string, number[]>;
  /** Absolute paths mentioned WITHOUT a line target — whole-file requests that supersede a line target. */
  wholeInputPaths?: string[];
}

/**
 * Parses an argv into a qunitx flag object (`inputs`, `debug`, `watch`, `failFast`, `timeout`, `output`, `port`, `before`, `after`).
 *
 * `argv` and `cwd` default to the live process, which is the CLI's call. They are parameters
 * rather than reads so the daemon and the JS API can parse someone else's invocation without
 * borrowing process globals to do it.
 *
 * ```ts
 * import * as Args from './index.ts';
 *
 * const parsed = Args.parse('/proj', ['--timeout=5000'], '/proj');
 * Args.InvalidFlag.is(parsed) ? parsed.code : parsed.timeout; // 5000
 * ```
 * @returns {object}
 */
export function parse(
  projectRoot: string,
  argv: readonly string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): Result<ParsedFlags, ParseFailure> {
  const flags: ParsedFlags = { inputs: [] };
  const positional: string[] = [];
  // The tokenizer owns how many argv entries a query flag swallows (see tokenize.ts); this
  // loop only interprets the resulting tokens. Query values and inputs are their own token kinds,
  // so the flag chain below never has to guess whether a bare word is a value or a path.
  for (const token of tokenize(argv)) {
    if (token.kind === 'query') {
      applyQuery(flags, token);
    } else if (token.kind === 'input') {
      positional.push(token.raw);
    } else {
      // First bad flag wins, matching the previous exit-on-first-error behaviour. Collecting
      // every complaint would be a different (and arguably better) UX, but it is not what the
      // exits did and is not this change's business.
      const failed = applyFlag(flags, token.raw);
      if (failed) return failed;
    }
  }
  applyInputs(flags, projectRoot, cwd, positional);

  // QUNITX_BROWSER env var is a lower-priority fallback: --browser flag wins if present.
  // Setting it in the environment lets all spawned child processes inherit the browser
  // without needing to pass --browser on every CLI invocation.
  if (!flags.browser && process.env.QUNITX_BROWSER) {
    const envBrowser = process.env.QUNITX_BROWSER;
    if (!BROWSERS.includes(envBrowser)) {
      return InvalidFlag({
        flag: 'QUNITX_BROWSER',
        value: envBrowser,
        expected: `Must be one of: ${BROWSERS.join(', ')}`,
      });
    }
    flags.browser = envBrowser as 'chromium' | 'firefox' | 'webkit';
  }

  // QUNITX_DEBUG env mirrors --debug: lower-priority than the explicit flag so
  // `--debug=false` still wins per-invocation. Lets CI / scripts opt every child
  // process into debug TAP comments without rewriting commands.
  if (flags.debug === undefined && process.env.QUNITX_DEBUG) {
    flags.debug = true;
  }

  return flags;
}

/**
 * Classifies raw positional targets into `flags`, exactly as the CLI does with argv positionals:
 * `.html` fixtures become `htmlPaths`, a trailing `#34`/`:34` becomes a `lineTargets` entry, and
 * everything else is an absolute path in `inputs` (deduplicated) plus a `wholeInputPaths` mention.
 *
 * Shared with the JS API so `run({ inputs: ['test/cart-test.ts#34'] })` means precisely what
 * `qunitx test/cart-test.ts#34` means — the same targeting grammar, resolved by the same code.
 * Idempotent for already-absolute inputs, so re-normalizing a parsed flag object is safe.
 *
 * ```ts
 * import * as Args from './index.ts';
 *
 * const flags = Args.applyInputs({ inputs: [] }, '/proj', '/proj', ['test/a-test.ts#4']);
 * flags.lineTargets; // { '/proj/test/a-test.ts': [4] } — the bare path still lands in `inputs`
 * ```
 */
export function applyInputs(
  flags: ParsedFlags,
  projectRoot: string,
  cwd: string,
  positional: readonly string[],
): ParsedFlags {
  const inputs = new Set(flags.inputs);
  for (const raw of positional) addInput(flags, inputs, projectRoot, cwd, raw);
  flags.inputs = Array.from(inputs);

  return flags;
}

/**
 * Interprets one non-query flag token (`token.raw` verbatim). This is the original prefix/`=`
 * matching chain, unchanged — the tokenizer only lifted `-t`/`-m` and positional inputs out of it.
 */
function applyFlag(result: ParsedFlags, arg: string): ParseFailure | undefined {
  // Every value flag reads the same `=`-suffix, so split once here. A bare boolean flag has no
  // suffix (value === undefined) and falls back to true via parseBoolean.
  const value = arg.split('=')[1];
  if (arg.startsWith('--debug') || arg.startsWith('--console')) {
    // --console is an alias for --debug: pipe the browser console to stdout.
    result.debug = parseBoolean(value);
  } else if (arg === '-w' || arg.startsWith('-w=') || arg.startsWith('--watch')) {
    result.watch = parseBoolean(value);
  } else if (arg === '-o' || arg.startsWith('-o=') || arg.startsWith('--open')) {
    result.open =
      value === undefined || value === 'true' ? true : value === 'false' ? false : value;
  } else if (arg.startsWith('--failfast') || arg.startsWith('--failFast')) {
    result.failFast = parseBoolean(value);
  } else if (arg === '-f' || arg.startsWith('--only-failed') || arg.startsWith('--failed')) {
    // Re-run only the test files that failed on the previous run (from the persistent
    // tmp/.qunitx-last-failures.json cache).
    result.onlyFailed = parseBoolean(value);
  } else if (arg.startsWith('--timeout')) {
    result.timeout = Number(value) || FALLBACK_TIMEOUT_MS;
  } else if (arg.startsWith('--output')) {
    result.output = value;
  } else if (arg.startsWith('--port') || arg === '-p' || arg.startsWith('-p=')) {
    // `--port` (short: `-p`); value is glued (`-p=8080`) like every non-query value flag.
    const port = Number(value);
    // Fail fast like the other value flags: a bare `--port` (Number(undefined) === NaN) or an
    // out-of-range value would otherwise reach the bind step as a NaN/invalid port.
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      return InvalidFlag({
        flag: '--port',
        value: value ?? '',
        expected: 'Expected --port=<0-65535> (short: -p).',
      });
    }
    result.port = port;
    result.portExplicit = true;
  } else if (arg.startsWith('--extensions')) {
    if (!value) {
      return InvalidFlag({
        flag: '--extensions',
        value: '',
        expected: 'Expected --extensions=js,ts.',
      });
    }
    result.extensions = value
      .split(',')
      .map((extension) => extension.trim())
      .filter(Boolean);
  } else if (arg.startsWith('--browser')) {
    if (!BROWSERS.includes(value)) {
      return InvalidFlag({
        flag: '--browser',
        value: value ?? '',
        expected: `Must be one of: ${BROWSERS.join(', ')}`,
      });
    }
    result.browser = value as 'chromium' | 'firefox' | 'webkit';
  } else if (arg.startsWith('--before')) {
    result.before = parseModule(value);
  } else if (arg.startsWith('--after')) {
    result.after = parseModule(value);
  } else if (arg === '--changed') {
    // Shorthand for --since=HEAD: "what tests does my working tree affect since the last commit?"
    result.changedSince = 'HEAD';
  } else if (arg.startsWith('--since')) {
    if (!value) {
      return InvalidFlag({ flag: '--since', value: '', expected: 'Expected --since=<git-ref>.' });
    }
    result.changedSince = value;
  } else if (arg.startsWith('--reporter') || arg === '-r' || arg.startsWith('-r=')) {
    // `--reporter` (short: `-r`) selects the single stdout format. Artifacts (--junit, --coverage)
    // are separate additive flags, so `--reporter=dot --junit` is a coherent combination. Value is
    // glued (`-r=spec`) like every non-query value flag.
    if (!value || !REPORTERS.includes(value as ReporterName)) {
      return InvalidFlag({
        flag: '--reporter',
        value: value ?? '',
        expected: `Must be one of: ${REPORTERS.join(', ')}`,
      });
    }
    result.reporter = value as ReporterName;
  } else if (arg.startsWith('--junit')) {
    // Bare `--junit` writes <output>/junit.xml; `--junit=<path>` overrides the destination.
    result.junit = value ? value : true;
  } else if (arg.startsWith('--coverage')) {
    // `--coverage` → terminal summary only. `--coverage=lcov,html` → also write those files.
    // `text` is an explicit alias for the always-on terminal summary, never an extra format.
    const formats = value
      ? value
          .split(',')
          .map((format) => format.trim())
          .filter(Boolean)
      : [];
    const invalid = formats.filter((format) => !COVERAGE_FORMATS.includes(format));
    if (invalid.length > 0) {
      return InvalidFlag({
        flag: '--coverage',
        value: invalid.join(', '),
        expected: 'Must be one of: lcov, html',
      });
    }
    result.coverage = true;
    result.coverageFormats = formats.filter((format) => format !== 'text');
  } else if (arg === '--trace-perf') {
    // consumed by perf-log.ts at module load time, not stored in config
  } else {
    // An unknown flag stays a warning rather than becoming a failure: it always has, and
    // promoting it would reject argv that older scripts and CI configs still pass.
    console.warn(`# Warning: Unknown flag "${arg}" — ignored`);
  }
  return undefined;
}

/** Adds a positional target: an `.html` fixture, or a test path with an optional `#34` line suffix. */
function addInput(
  result: ParsedFlags,
  inputs: Set<string>,
  projectRoot: string,
  cwd: string,
  arg: string,
): void {
  if (arg.endsWith('.html')) {
    (result.htmlPaths ??= []).push(arg);
    return;
  }
  // A trailing `#34` / `:34` narrows the run to the test at that line; the bare path is what
  // still goes into inputs, so discovery is unaffected.
  const { filePath, line } = splitLineTarget(arg);
  // path.isAbsolute() is the cross-platform absolute-path check: matches '/'-prefix on POSIX and
  // drive-letter prefixes ('D:\…') on Windows. path.normalize collapses mixed separators so a
  // Windows path typed with '/' (`C:\dir/a.ts`) keys lineTargets and matches coversFileWhole the
  // same way the backslash fs path does — otherwise the supersede prune and line lookup miss.
  const absolutePath = path.normalize(
    filePath.startsWith(projectRoot) || path.isAbsolute(filePath)
      ? filePath
      : path.join(cwd, filePath),
  );
  if (line !== null) {
    result.lineTargets = result.lineTargets ?? {};
    result.lineTargets[absolutePath] = (result.lineTargets[absolutePath] ?? []).concat(line);
  } else {
    // A bare mention (no `#line`) means "run this whole file". Recorded so a line target on the
    // same path — from `a.ts a.ts#34` — is superseded like any other broader input (see config.ts).
    // Tracked separately because `inputs` is a Set: the bare and line-target mentions collapse to
    // one entry, losing the fact that a whole-file mention was made.
    (result.wholeInputPaths ??= []).push(absolutePath);
  }
  inputs.add(absolutePath);
}

/**
 * Applies a query token. `-t`/`--filter`/`-m`/`--module` are four spellings of one matcher, so a
 * second one overrides the first (last-wins, as for any repeated scalar flag) — but says so rather
 * than silently dropping the earlier expression.
 */
function applyQuery(result: ParsedFlags, token: QueryToken): void {
  if (token.action === 'list') {
    // A bare --search/--print (no expression) lists everything; run.ts falls back to `filter`.
    result.search = token.value ?? true;
  } else if (token.value !== null) {
    if (result.filter !== undefined && result.filter !== token.value) {
      console.warn(
        `# Note: the test filter was given more than once — using "${token.value}", ignoring "${result.filter}". ` +
          `-t, --filter, -m and --module are all the same flag.`,
      );
    }
    result.filter = token.value;
  }
  warnSwallowedTarget(token);
}

/**
 * Warns when a greedy value contains a word that looks like a test file — the tell-tale of a
 * target accidentally swallowed into the expression (`-t login flow test/foo.ts`). Only fires for
 * greedily-consumed values (an explicit `--filter=…` is taken as intended) and only on a file
 * extension, so a regex like `/add.ts?/` or an ordinary name never trips it.
 */
function warnSwallowedTarget(token: QueryToken): void {
  if (!token.greedy || token.value === null) return;
  const suspects = token.value.split(' ').filter((word) => FILE_LOOKING.test(word));
  if (suspects.length === 0) return;
  const flag = token.action === 'list' ? '--search/-s' : '--filter/-t';
  console.warn(
    `# Note: ${flag} consumed ${suspects.map((s) => `"${s}"`).join(', ')} as filter text — put ` +
      `file targets before the filter, separate them with "--", or quote the filter.`,
  );
}

function parseBoolean(result: string, defaultValue = true): boolean {
  if (result === 'true') {
    return true;
  } else if (result === 'false') {
    return false;
  }

  return defaultValue;
}

function parseModule(value: string): string | false {
  if (['false', "'false'", '"false"', ''].includes(value)) {
    return false;
  }

  return value;
}

/**
 * Splits a trailing `#34` / `:34` line target off an input path.
 * The `[^#:]` before the separator keeps the path non-empty, and requiring an all-digit
 * suffix leaves genuine `#`/`:` in filenames — and Windows drive letters — untouched.
 */
function splitLineTarget(arg: string): { filePath: string; line: number | null } {
  const match = /^(.*[^#:])[#:](\d+)$/.exec(arg);
  if (!match) {
    return { filePath: arg, line: null };
  }

  const line = Number(match[2]);

  return line > 0 ? { filePath: match[1], line } : { filePath: arg, line: null };
}
