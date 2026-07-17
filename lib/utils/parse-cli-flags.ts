import path from 'node:path';
import { tokenizeArgs, type QueryToken } from './tokenize-args.ts';
import { REPORTERS, type ReporterName } from '../reporter/types.ts';

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
}

/**
 * Parses `process.argv` into a qunitx flag object (`inputs`, `debug`, `watch`, `failFast`, `timeout`, `output`, `port`, `before`, `after`).
 * @returns {object}
 */
export function parseCliFlags(projectRoot: string): ParsedFlags {
  const providedFlags = { inputs: new Set<string>() } as ParsedFlags & { inputs: Set<string> };
  // The tokenizer owns how many argv entries a query flag swallows (see tokenize-args.ts); this
  // loop only interprets the resulting tokens. Query values and inputs are their own token kinds,
  // so the flag chain below never has to guess whether a bare word is a value or a path.
  for (const token of tokenizeArgs(process.argv.slice(2))) {
    if (token.kind === 'query') {
      applyQuery(providedFlags, token);
    } else if (token.kind === 'input') {
      addInput(providedFlags, projectRoot, token.raw);
    } else {
      applyFlag(providedFlags, token.raw);
    }
  }

  // QUNITX_BROWSER env var is a lower-priority fallback: --browser flag wins if present.
  // Setting it in the environment lets all spawned child processes inherit the browser
  // without needing to pass --browser on every CLI invocation.
  if (!providedFlags.browser && process.env.QUNITX_BROWSER) {
    const envBrowser = process.env.QUNITX_BROWSER;
    if (!['chromium', 'firefox', 'webkit'].includes(envBrowser)) {
      console.error(
        `Invalid QUNITX_BROWSER value: "${envBrowser}". Must be one of: chromium, firefox, webkit`,
      );
      process.exit(1);
    }
    providedFlags.browser = envBrowser as 'chromium' | 'firefox' | 'webkit';
  }

  // QUNITX_DEBUG env mirrors --debug: lower-priority than the explicit flag so
  // `--debug=false` still wins per-invocation. Lets CI / scripts opt every child
  // process into debug TAP comments without rewriting commands.
  if (providedFlags.debug === undefined && process.env.QUNITX_DEBUG) {
    providedFlags.debug = true;
  }

  return { ...providedFlags, inputs: Array.from(providedFlags.inputs) };
}

export { parseCliFlags as default };

type Flags = ParsedFlags & { inputs: Set<string> };

/**
 * Interprets one non-query flag token (`token.raw` verbatim). This is the original prefix/`=`
 * matching chain, unchanged — the tokenizer only lifted `-t`/`-m` and positional inputs out of it.
 */
function applyFlag(result: Flags, arg: string): void {
  if (arg.startsWith('--debug') || arg.startsWith('--console')) {
    // --console is an alias for --debug: pipe the browser console to stdout.
    result.debug = parseBoolean(arg.split('=')[1]);
  } else if (arg === '-w' || arg.startsWith('-w=') || arg.startsWith('--watch')) {
    result.watch = parseBoolean(arg.split('=')[1]);
  } else if (arg === '-o' || arg.startsWith('-o=') || arg.startsWith('--open')) {
    const value = arg.split('=')[1];
    result.open =
      value === undefined || value === 'true' ? true : value === 'false' ? false : value;
  } else if (arg.startsWith('--failfast') || arg.startsWith('--failFast')) {
    result.failFast = parseBoolean(arg.split('=')[1]);
  } else if (arg === '-f' || arg.startsWith('--only-failed') || arg.startsWith('--failed')) {
    // Re-run only the test files that failed on the previous run (from the persistent
    // tmp/.qunitx-last-failures.json cache).
    result.onlyFailed = parseBoolean(arg.split('=')[1]);
  } else if (arg.startsWith('--timeout')) {
    result.timeout = Number(arg.split('=')[1]) || FALLBACK_TIMEOUT_MS;
  } else if (arg.startsWith('--output')) {
    result.output = arg.split('=')[1];
  } else if (arg.startsWith('--port')) {
    result.port = Number(arg.split('=')[1]);
    result.portExplicit = true;
  } else if (arg.startsWith('--extensions')) {
    const value = arg.split('=')[1];
    if (!value) {
      console.error(`Invalid --extensions value: empty. Expected --extensions=js,ts.`);
      process.exit(1);
    }
    result.extensions = value
      .split(',')
      .map((extension) => extension.trim())
      .filter(Boolean);
  } else if (arg.startsWith('--browser')) {
    const value = arg.split('=')[1];
    if (!['chromium', 'firefox', 'webkit'].includes(value)) {
      console.error(
        `Invalid --browser value: "${value}". Must be one of: chromium, firefox, webkit`,
      );
      process.exit(1);
    }
    result.browser = value as 'chromium' | 'firefox' | 'webkit';
  } else if (arg.startsWith('--before')) {
    result.before = parseModule(arg.split('=')[1]);
  } else if (arg.startsWith('--after')) {
    result.after = parseModule(arg.split('=')[1]);
  } else if (arg === '--changed') {
    // Shorthand for --since=HEAD: "what tests does my working tree affect since the last commit?"
    result.changedSince = 'HEAD';
  } else if (arg.startsWith('--since')) {
    const ref = arg.split('=')[1];
    if (!ref) {
      console.error(`Invalid --since value: empty. Expected --since=<git-ref>.`);
      process.exit(1);
    }
    result.changedSince = ref;
  } else if (arg.startsWith('--reporter') || arg === '-r' || arg.startsWith('-r=')) {
    // `--reporter` (short: `-r`) selects the single stdout format. Artifacts (--junit, --coverage)
    // are separate additive flags, so `--reporter=dot --junit` is a coherent combination. Value is
    // glued (`-r=spec`) like every non-query value flag.
    const value = arg.split('=')[1];
    if (!value || !REPORTERS.includes(value as ReporterName)) {
      console.error(
        `Invalid --reporter value: "${value ?? ''}". Must be one of: ${REPORTERS.join(', ')}`,
      );
      process.exit(1);
    }
    result.reporter = value as ReporterName;
  } else if (arg.startsWith('--junit')) {
    // Bare `--junit` writes <output>/junit.xml; `--junit=<path>` overrides the destination.
    const value = arg.split('=')[1];
    result.junit = value ? value : true;
  } else if (arg.startsWith('--coverage')) {
    // `--coverage` → terminal summary only. `--coverage=lcov,html` → also write those files.
    // `text` is an explicit alias for the always-on terminal summary, never an extra format.
    const value = arg.split('=')[1];
    const formats = value
      ? value
          .split(',')
          .map((format) => format.trim())
          .filter(Boolean)
      : [];
    const invalid = formats.filter((format) => !['text', 'lcov', 'html'].includes(format));
    if (invalid.length > 0) {
      console.error(
        `Invalid --coverage format(s): "${invalid.join(', ')}". Must be one of: lcov, html`,
      );
      process.exit(1);
    }
    result.coverage = true;
    result.coverageFormats = formats.filter((format) => format !== 'text');
  } else if (arg === '--trace-perf') {
    // consumed by perf-logger.js at module load time, not stored in config
  } else {
    console.warn(`# Warning: Unknown flag "${arg}" — ignored`);
  }
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
  }
  result.inputs.add(absolutePath);
}

/**
 * Applies a query token. `-t`/`--filter`/`-m`/`--module` are four spellings of one matcher, so a
 * second one overrides the first (last-wins, as for any repeated scalar flag) — but says so rather
 * than silently dropping the earlier expression.
 */
function applyQuery(result: Flags, token: QueryToken): void {
  if (token.key === 'list') {
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
  const flag = token.key === 'list' ? '--search/-s' : '--filter/-t';
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
