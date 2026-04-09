// { inputs: [], debug: true, watch: true, open: true, failFast: true, htmlPaths: [], output }
interface ParsedFlags {
  inputs: string[];
  debug?: boolean;
  watch?: boolean;
  open?: boolean;
  failFast?: boolean;
  timeout?: number;
  output?: string;
  htmlPaths?: string[];
  port?: number;
  portExplicit?: boolean;
  extensions?: string[];
  browser?: 'chromium' | 'firefox' | 'webkit';
  before?: string | false;
  after?: string | false;
}

/**
 * Parses `process.argv` into a qunitx flag object (`inputs`, `debug`, `watch`, `failFast`, `timeout`, `output`, `port`, `before`, `after`).
 * @returns {object}
 */
export default function parseCliFlags(projectRoot: string): ParsedFlags {
  const providedFlags = process.argv.slice(2).reduce(
    (result, arg) => {
      if (arg.startsWith('--debug')) {
        return Object.assign(result, { debug: parseBoolean(arg.split('=')[1]) });
      } else if (arg.startsWith('--watch')) {
        return Object.assign(result, { watch: parseBoolean(arg.split('=')[1]) });
      } else if (arg === '-o' || arg.startsWith('--open')) {
        return Object.assign(result, { open: parseBoolean(arg.split('=')[1]) });
      } else if (arg.startsWith('--failfast') || arg.startsWith('--failFast')) {
        return Object.assign(result, { failFast: parseBoolean(arg.split('=')[1]) });
      } else if (arg.startsWith('--timeout')) {
        return Object.assign(result, { timeout: Number(arg.split('=')[1]) || 10000 });
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
            .map((e) => e.trim()),
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
      } else if (arg === '--trace-perf') {
        return result; // consumed by perf-logger.js at module load time, not stored in config
      }

      // maybe set watch depth via micromatch(so incl metadata)
      if (arg.startsWith('-')) {
        console.warn(`# Warning: Unknown flag "${arg}" — ignored`);
        return result;
      }
      result.inputs.add(arg.startsWith(projectRoot) ? arg : `${process.cwd()}/${arg}`);

      return result;
    },
    { inputs: new Set<string>([]) } as ParsedFlags & { inputs: Set<string> },
  );

  return { ...providedFlags, inputs: Array.from(providedFlags.inputs) };
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
