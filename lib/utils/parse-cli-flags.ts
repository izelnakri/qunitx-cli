import path from 'node:path';

// Fallback when --timeout is passed with an unparseable or zero value.
const FALLBACK_TIMEOUT_MS = 10_000;

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
}

/**
 * Parses `process.argv` into a qunitx flag object (`inputs`, `debug`, `watch`, `failFast`, `timeout`, `output`, `port`, `before`, `after`).
 * @returns {object}
 */
export function parseCliFlags(projectRoot: string): ParsedFlags {
  const providedFlags = process.argv.slice(2).reduce(
    (result, arg) => {
      if (arg.startsWith('--debug')) {
        return Object.assign(result, { debug: parseBoolean(arg.split('=')[1]) });
      } else if (arg.startsWith('--watch')) {
        return Object.assign(result, { watch: parseBoolean(arg.split('=')[1]) });
      } else if (arg === '-o' || arg.startsWith('-o=') || arg.startsWith('--open')) {
        const value = arg.split('=')[1];
        const open =
          value === undefined || value === 'true' ? true : value === 'false' ? false : value;
        return Object.assign(result, { open });
      } else if (arg.startsWith('--failfast') || arg.startsWith('--failFast')) {
        return Object.assign(result, { failFast: parseBoolean(arg.split('=')[1]) });
      } else if (arg === '-f' || arg.startsWith('--only-failed') || arg.startsWith('--failed')) {
        // Re-run only the test files that failed on the previous run (from the persistent
        // tmp/.qunitx-last-failures.json cache). Checked before the generic flag handling below.
        return Object.assign(result, { onlyFailed: parseBoolean(arg.split('=')[1]) });
      } else if (arg.startsWith('--timeout')) {
        return Object.assign(result, { timeout: Number(arg.split('=')[1]) || FALLBACK_TIMEOUT_MS });
      } else if (arg.startsWith('--output')) {
        return Object.assign(result, { output: arg.split('=')[1] });
      } else if (arg.endsWith('.html')) {
        if (result.htmlPaths) {
          result.htmlPaths.push(arg);
        } else {
          result.htmlPaths = [arg];
        }

        return result;
      } else if (arg.startsWith('--port')) {
        return Object.assign(result, { port: Number(arg.split('=')[1]), portExplicit: true });
      } else if (arg.startsWith('--extensions')) {
        return Object.assign(result, {
          extensions: arg
            .split('=')[1]
            .split(',')
            .map((extension) => extension.trim()),
        });
      } else if (arg.startsWith('--browser')) {
        const value = arg.split('=')[1];
        if (!['chromium', 'firefox', 'webkit'].includes(value)) {
          console.error(
            `Invalid --browser value: "${value}". Must be one of: chromium, firefox, webkit`,
          );
          process.exit(1);
        }
        return Object.assign(result, { browser: value as 'chromium' | 'firefox' | 'webkit' });
      } else if (arg.startsWith('--before')) {
        return Object.assign(result, { before: parseModule(arg.split('=')[1]) });
      } else if (arg.startsWith('--after')) {
        return Object.assign(result, { after: parseModule(arg.split('=')[1]) });
      } else if (arg === '--changed') {
        // Shorthand for --since=HEAD. Most common case: "what tests does my
        // working tree affect compared to last commit?"
        return Object.assign(result, { changedSince: 'HEAD' });
      } else if (arg.startsWith('--since')) {
        const ref = arg.split('=')[1];
        if (!ref) {
          console.error(`Invalid --since value: empty. Expected --since=<git-ref>.`);
          process.exit(1);
        }
        return Object.assign(result, { changedSince: ref });
      } else if (arg === '--trace-perf') {
        return result; // consumed by perf-logger.js at module load time, not stored in config
      }

      // maybe set watch depth via micromatch(so incl metadata)
      if (arg.startsWith('-')) {
        console.warn(`# Warning: Unknown flag "${arg}" — ignored`);
        return result;
      }
      // path.isAbsolute() is the cross-platform absolute-path check: matches '/'-prefix
      // on POSIX and drive-letter prefixes ('D:\…') on Windows. The previous explicit
      // '/' check missed Windows absolute paths and silently joined them onto cwd,
      // producing 'D:\<cwd>\D:\<arg>' — a path that fails to stat with ENOENT.
      result.inputs.add(
        arg.startsWith(projectRoot) || path.isAbsolute(arg) ? arg : path.join(process.cwd(), arg),
      );

      return result;
    },
    { inputs: new Set<string>([]) } as ParsedFlags & { inputs: Set<string> },
  );

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
