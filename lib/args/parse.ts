import path from 'node:path';
import { tokenize, type QueryToken } from './tokenize.ts';
import { REPORTERS, type ReporterName } from '../reporters/types.ts';
import { type Result, ok, err, Failure } from '../result/index.ts';

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
 */
export const InvalidFlag = Failure.define(
  'InvalidFlag',
  (data: { flag: string; value: string; expected: string }) =>
    `Invalid ${data.flag} value: "${data.value}". ${data.expected}`,
);

/** Every way `parse()` can reject its input. */
export type ParseFailure = Failure.Of<typeof InvalidFlag>;

const BROWSERS = ['chromium', 'firefox', 'webkit'];
const COVERAGE_FORMATS = ['text', 'lcov', 'html'];

// Fallback when --timeout is passed with an unparseable or zero value.
const FALLBACK_TIMEOUT_MS = 10_000;

// Default discovery extensions, duplicated from defaultProjectConfigValues so the swallowed-target
// hint can run at parse time (config, which owns the real list, is built from these flags).
const FILE_LOOKING = /\.(js|ts|jsx|tsx|html)$/;

// { inputs: [], debug: true, watch: true, open: true, failFast: true, onlyFailed: true, htmlPaths: [], output }
interface ParsedFlags {
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
 * Parses `process.argv` into a qunitx flag object (`inputs`, `debug`, `watch`, `failFast`, `timeout`, `output`, `port`, `before`, `after`).
 * @returns {object}
 */
export function parse(projectRoot: string): Result<ParsedFlags, ParseFailure> {
  const providedFlags = { inputs: new Set<string>() } as ParsedFlags & { inputs: Set<string> };
  // The tokenizer owns how many argv entries a query flag swallows (see tokenize.ts); this
  // loop only interprets the resulting tokens. Query values and inputs are their own token kinds,
  // so the flag chain below never has to guess whether a bare word is a value or a path.
  for (const token of tokenize(process.argv.slice(2))) {
    if (token.kind === 'query') {
      applyQuery(providedFlags, token);
    } else if (token.kind === 'input') {
      addInput(providedFlags, projectRoot, token.raw);
    } else {
      // First bad flag wins, matching the previous exit-on-first-error behaviour. Collecting
      // every complaint would be a different (and arguably better) UX, but it is not what the
      // exits did and is not this change's business.
      const applied = applyFlag(providedFlags, token.raw);
      if (!applied.ok) return applied;
    }
  }

  // QUNITX_BROWSER env var is a lower-priority fallback: --browser flag wins if present.
  // Setting it in the environment lets all spawned child processes inherit the browser
  // without needing to pass --browser on every CLI invocation.
  if (!providedFlags.browser && process.env.QUNITX_BROWSER) {
    const envBrowser = process.env.QUNITX_BROWSER;
    if (!BROWSERS.includes(envBrowser)) {
      return err(
        InvalidFlag({
          flag: 'QUNITX_BROWSER',
          value: envBrowser,
          expected: `Must be one of: ${BROWSERS.join(', ')}`,
        }),
      );
    }
    providedFlags.browser = envBrowser as 'chromium' | 'firefox' | 'webkit';
  }

  // QUNITX_DEBUG env mirrors --debug: lower-priority than the explicit flag so
  // `--debug=false` still wins per-invocation. Lets CI / scripts opt every child
  // process into debug TAP comments without rewriting commands.
  if (providedFlags.debug === undefined && process.env.QUNITX_DEBUG) {
    providedFlags.debug = true;
  }

  return ok({ ...providedFlags, inputs: Array.from(providedFlags.inputs) });
}

type Flags = ParsedFlags & { inputs: Set<string> };

/**
 * Interprets one non-query flag token (`token.raw` verbatim). This is the original prefix/`=`
 * matching chain, unchanged — the tokenizer only lifted `-t`/`-m` and positional inputs out of it.
 */
function applyFlag(result: Flags, arg: string): Result<void, ParseFailure> {
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
      return err(
        InvalidFlag({
          flag: '--port',
          value: value ?? '',
          expected: 'Expected --port=<0-65535> (short: -p).',
        }),
      );
    }
    result.port = port;
    result.portExplicit = true;
  } else if (arg.startsWith('--extensions')) {
    if (!value) {
      return err(
        InvalidFlag({ flag: '--extensions', value: '', expected: 'Expected --extensions=js,ts.' }),
      );
    }
    result.extensions = value
      .split(',')
      .map((extension) => extension.trim())
      .filter(Boolean);
  } else if (arg.startsWith('--browser')) {
    if (!BROWSERS.includes(value)) {
      return err(
        InvalidFlag({
          flag: '--browser',
          value: value ?? '',
          expected: `Must be one of: ${BROWSERS.join(', ')}`,
        }),
      );
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
      return err(
        InvalidFlag({ flag: '--since', value: '', expected: 'Expected --since=<git-ref>.' }),
      );
    }
    result.changedSince = value;
  } else if (arg.startsWith('--reporter') || arg === '-r' || arg.startsWith('-r=')) {
    // `--reporter` (short: `-r`) selects the single stdout format. Artifacts (--junit, --coverage)
    // are separate additive flags, so `--reporter=dot --junit` is a coherent combination. Value is
    // glued (`-r=spec`) like every non-query value flag.
    if (!value || !REPORTERS.includes(value as ReporterName)) {
      return err(
        InvalidFlag({
          flag: '--reporter',
          value: value ?? '',
          expected: `Must be one of: ${REPORTERS.join(', ')}`,
        }),
      );
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
      return err(
        InvalidFlag({
          flag: '--coverage',
          value: invalid.join(', '),
          expected: 'Must be one of: lcov, html',
        }),
      );
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
  return ok();
}

/** Adds a positional target: an `.html` fixture, or a test path with an optional `#34` line suffix. */
function addInput(result: Flags, projectRoot: string, arg: string): void {
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
      : path.join(process.cwd(), filePath),
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
  result.inputs.add(absolutePath);
}

/**
 * Applies a query token. `-t`/`--filter`/`-m`/`--module` are four spellings of one matcher, so a
 * second one overrides the first (last-wins, as for any repeated scalar flag) — but says so rather
 * than silently dropping the earlier expression.
 */
function applyQuery(result: Flags, token: QueryToken): void {
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
