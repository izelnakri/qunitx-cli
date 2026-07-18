import type { Config } from '../types.ts';
import type { QunitxOptions, RunOptions, WatchOptions } from './types.ts';

/**
 * Maps public options onto internal `Config` fields. Mostly a rename table, but keeping it
 * explicit is what stops an internal rename from silently becoming a breaking API change, and
 * what keeps `undefined` out of the config (an explicit `undefined` in the override spread
 * would clobber a `package.json` value).
 *
 * `files` is deliberately absent: it is passed as argv instead, so the API inherits the CLI's
 * whole input pipeline — globs, `file.ts#34` line targets, and line-target supersession —
 * rather than reimplementing it against a plain `inputs` array.
 */
export function toConfigOverrides(options: RunOptions & WatchOptions): Partial<Config> {
  const overrides: Partial<Config> = {};

  assign(overrides, 'browser', options.browser);
  assign(overrides, 'filter', options.filter);
  assign(overrides, 'extensions', options.extensions);
  assign(overrides, 'htmlPaths', options.htmlPaths);
  assign(overrides, 'output', options.output);
  assign(overrides, 'timeout', options.timeout);
  assign(overrides, 'plugins', options.plugins);
  assign(overrides, 'debug', options.debug);
  assign(overrides, 'failFast', options.failFast);
  assign(overrides, 'onlyFailed', options.onlyFailed);
  assign(overrides, 'changedSince', options.changedSince);
  assign(overrides, 'coverage', options.coverage);
  assign(overrides, 'coverageFormats', options.coverageFormats);
  assign(overrides, 'junit', options.junit);
  // A library writing to its host's stdout by default would be a surprise; opt in with
  // `reporter: 'tap'` (or any other) to get the CLI's output.
  overrides.reporter = options.reporter ?? 'none';

  if (options.port !== undefined) {
    // Mirrors `--port`: an explicitly requested port is a hard requirement, so startup fails
    // rather than silently drifting to the next free one.
    overrides.port = options.port;
    overrides.portExplicit = true;
  }

  return overrides;
}

/** Copies `value` onto `target[key]` only when it was actually provided. */
function assign<Key extends keyof Config>(
  target: Partial<Config>,
  key: Key,
  value: Config[Key] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

export type { QunitxOptions };
