import fs from 'node:fs';
import { isBuiltin } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { format } from 'node:util';
import esbuild from 'esbuild';
import * as Browser from '../setup/browser.ts';
import * as Failure from '../result/failure.ts';
import * as SourceMap from '../utils/source-map.ts';
import { HTTPServer, type RouteHandler } from '../web/index.ts';
import { bindServerToPort } from '../setup/bind-server-to-port.ts';
import { blue, magenta, red, yellow } from '../utils/color.ts';
import { closeCompletely } from '../utils/close-with-grace.ts';
import { findProjectRoot } from '../utils/find-project-root.ts';
import { isRemoteInput } from '../setup/remote-inputs.ts';
import { REMOTE_NAMESPACE, remoteModulePlugin } from '../setup/remote-module-plugin.ts';
import { qunitxRuntimePlugin } from '../setup/qunitx-runtime-plugin.ts';
import { resolvePlugins } from '../setup/config.ts';
import { shutdownPrelaunch } from '../chrome/prelaunch.ts';
import { processConsole, type Console } from '../console.ts';
import { realWatchDirectories, watchDirectoriesFrom, watchLoop } from './run.ts';
import { installBench, type BenchEntry, type BenchTiming } from '../bench/harness.ts';
import * as Report from '../bench/report.ts';
import * as Compare from '../bench/compare.ts';
import type { Browser as PlaywrightBrowser, Page } from 'playwright-core';
import type { SourceMapDecoder } from '../utils/source-map.ts';

// The route the bundle is served from: SourceMap.isBundleUrl knows `script.js`, so a failed
// bench's stack points at the file it was written in.
const BUNDLE_ROUTE = '/script.js';
const highlight = (text: string): string => magenta().bold(text);
const color = (text: string): string => blue(text);
const ENTRY_SPECIFIER = 'qunitx:bench-entry';
const NAVIGATION_TIMEOUT_MS = 30_000;
// `deno bench`'s file names: `bench.ts`, `x_bench.ts`, `x.bench.ts`, and the same for js, jsx,
// tsx, mts and mjs.
const BENCH_FILE = /^(?:.*[._])?bench\.(?:[mc]?[jt]sx?)$/;
// esbuild's text for an import it found nothing for.
const UNRESOLVED = /^Could not resolve "(.+)"$/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'tmp', 'dist', 'coverage']);
// Cross-origin isolated, as a page must be to get `performance.now()` to microseconds rather than
// 100µs, and never cached.
const DEFAULT_HTTP_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};
// A file's outcome before it measured anything.
const NOTHING_MEASURED: FileOutcome = {
  benches: [],
  changes: [],
  failed: false,
  onlyUsed: false,
  aborted: false,
};
// By browser: the engine esbuild compiles for, and the runtime the report names.
const TARGETS: Record<string, string> = {
  chromium: 'chrome120',
  firefox: 'firefox115',
  webkit: 'safari16',
};
const RUNTIMES: Record<string, string> = {
  chromium: 'Chromium',
  firefox: 'Firefox',
  webkit: 'WebKit',
};

/**
 * Every setting of a `qunitx bench` run: the command line's flags and the JS API's options, as
 * `package.json#qunitx.bench` can also give them. Every one is optional.
 *
 * ```ts
 * const settings: BenchSettings = { browser: 'firefox', filter: '/^render/', compare: 'tmp/base.json', threshold: 15 };
 * ```
 */
export interface BenchSettings {
  /** Where inputs resolve from. Defaults to the process's. */
  cwd?: string;
  /** Engine to measure in. Defaults to chromium. */
  browser?: 'chromium' | 'firefox' | 'webkit';
  /** Only the benches whose name contains this, or matches it as `/a regex/`. */
  filter?: string;
  /** Files, folders or globs never run. */
  ignore?: string[];
  /** How results are printed. Defaults to `pretty`. */
  format?: Report.BenchFormat;
  /** Write the results, as `deno bench --json` does, to this file. */
  save?: string;
  /** A baseline to compare with: `--save`'s or `deno bench --json`'s output. */
  compare?: string;
  /** Percent slower that counts as a regression. Defaults to 10. */
  threshold?: number;
  /** Nanoseconds slower that counts, at the least. Defaults to 1000. */
  minDelta?: number;
  /** Times a regressed bench is measured again before it fails, keeping its best. Defaults to 2. */
  retries?: number;
  /** Milliseconds each bench warms up. Defaults to 100. */
  warmup?: number;
  /** Milliseconds each bench is measured for. Defaults to 500. */
  time?: number;
  /** Slow the CPU down this many times, as a slower device would run (chromium). */
  cpuThrottle?: number;
  /** Write a CPU profile of each bench into this directory (chromium). */
  profile?: string;
  /** Bundle the files to check they build, but measure nothing. */
  noRun?: boolean;
  /** No bench files is not an error. */
  permitNoFiles?: boolean;
  /** Measure again whenever a file a bench imports changes. */
  watch?: boolean;
  /** First port tried for the local server. Defaults to 1234. */
  port?: number;
  /** Milliseconds one file may run before it is declared hung. Unbounded by default. */
  timeout?: number;
  /** Where the report and the benches' console output go. Defaults to the process's. */
  console?: Console;
  /**
   * Stops the run: between benches, or in the middle of one by closing its page. The benches
   * measured by then are the result, with `aborted: true`; an already-aborted signal launches
   * nothing.
   */
  signal?: AbortSignal;
  /** Called with each bench as it is measured, in the order they run: for progress, or a UI. */
  onResult?: (entry: BenchEntry) => void;
}

/**
 * What a run produced: its report in `deno bench --json`'s shape, how it compared with the
 * baseline, the files that ran, and the exit code the command line exits with — 1 for a failed
 * bench, a regression, a file that would not build, or an `only` left in.
 *
 * ```ts
 * const result: BenchResult = { ok: true, exitCode: 0, aborted: false, report: { version: 1, runtime: '', cpu: '', benches: [] }, comparison: null, files: [] };
 * ```
 */
export interface BenchResult {
  /** True when the exit code is 0. */
  ok: boolean;
  /** 0 or 1. */
  exitCode: number;
  /** Whether `signal` stopped the run before every bench was measured. */
  aborted: boolean;
  /** Every bench, as `deno bench --json` reports it. */
  report: Report.BenchReport;
  /** The run against `compare`'s baseline, or null without one. */
  comparison: Compare.Comparison | null;
  /** The bench files, absolute (or URLs). */
  files: string[];
}

/**
 * `qunitx bench --help`.
 *
 * ```ts
 * import { BENCH_USAGE } from './bench.ts';
 *
 * BENCH_USAGE.includes('--compare'); // true
 * ```
 */
export const BENCH_USAGE = `${highlight('Usage:')} qunitx bench [files, folders or globs] [flags]

Runs benchmark files in a real browser. They are written as for ${color('deno bench')} — ${color('Deno.bench(name, fn)')},
${color('Deno.bench({ name, group, baseline, only, ignore, n, warmup, fn })')}, ${color('b.start()')} / ${color('b.end()')} — so one file runs under
both, or with the global ${color('bench(...)')}. Files are bench.ts, *_bench.ts and *.bench.ts (or .js, .jsx, .tsx, .mts,
.mjs); no inputs means the current folder. Each file runs in a fresh, cross-origin-isolated page, one at a time.

${color('$ qunitx bench benches/render.bench.ts --browser=firefox')}
${color('$ qunitx bench --save=tmp/base.json')} then ${color('$ qunitx bench --compare=tmp/base.json')}  # exit 1 on a regression

${highlight('Flags:')}
${color('--browser')}       : chromium (default), firefox or webkit
${color('-t, --filter')}    : only benches whose name contains this, or matches ${color('/a regex/')}
${color('--ignore')}        : files, folders or globs to leave out, comma-separated
${color('-r, --reporter')}  : ${color('pretty')} (default: deno bench's table), ${color('json')} (deno bench --json's), ${color('markdown')}, ${color('csv')}
${color('--json')}          : the same as ${color('--reporter=json')}
${color('--save')}          : write the results as JSON to this file, the baseline for ${color('--compare')}
${color('--compare')}       : compare with a baseline — ${color('--save')}'s, or ${color('deno bench --json')}'s — and exit 1 on a regression
${color('--threshold')}     : percent slower that counts as a regression (default 10; doubled under 1µs)
${color('--min-delta')}     : time slower that counts, at the least: ${color('500ns')}, ${color('2µs')}, ${color('1ms')} (default 1µs)
${color('--retries')}       : times a regressed bench is measured again, keeping its best (default 2)
${color('--warmup')}        : ms each bench warms up (default 100)
${color('--time')}          : ms each bench is measured for (default 500)
${color('--cpu-throttle')}  : slow the CPU down N times, as a slower device would run (chromium)
${color('--profile')}       : write each bench's CPU profile to ${color('tmp/bench-profiles')}, or the folder given (chromium)
${color('--no-run')}        : bundle the files to check they build; measure nothing
${color('--permit-no-files')} : no bench files is not an error
${color('-w, --watch')}     : measure again when a file a bench imports changes
${color('-p, --port')}      : first port tried for the local server
${color('--timeout')}       : ms one file may run before it is declared hung

${highlight('package.json:')} ${color('"qunitx": { "bench": { "inputs": ["benches"], "threshold": 15, "browser": "firefox" } }')} sets the same
by their JS names (${color('minDelta')}, ${color('cpuThrottle')}…); flags win. ${color('qunitx.plugins')} apply as they do to tests.
`;

/**
 * Runs `qunitx bench` for the command line: parses `argv`, runs, and returns the exit code — 0,
 * 1 for a failed or regressed bench, 2 for flags that will not do.
 *
 * ```ts
 * import { command } from './bench.ts';
 *
 * // Defined, not invoked: launches a browser.
 * async function cli() {
 *   return await command(['benches', '--json']);
 * }
 * ```
 */
export async function command(
  argv: string[] = process.argv.slice(3),
  out: Console = processConsole,
): Promise<number> {
  const parsed = parseArgs(argv);
  if (Failure.is(parsed)) {
    out.error(`${parsed.message}\n\n${BENCH_USAGE}`);
    return 2;
  } else if (parsed.help) {
    out.log(BENCH_USAGE);
    return 0;
  }
  try {
    return (await run(parsed.inputs, { ...parsed.settings, console: out })).exitCode;
  } catch (error) {
    out.error(`${red('error')}: ${Failure.is(error) ? error.message : Failure.format(error)}\n`);
    return InvalidBenchSetting.is(error) ? 2 : 1;
  }
}

/**
 * A `qunitx bench` flag, setting or baseline that will not do.
 *
 * ```ts
 * import { InvalidBenchSetting } from './bench.ts';
 *
 * InvalidBenchSetting({ setting: 'threshold', reason: 'expected a percentage, got "x"' }).message;
 * // 'qunitx bench threshold: expected a percentage, got "x"'
 * ```
 */
export const InvalidBenchSetting: Failure.FailureFactory<
  'InvalidBenchSetting',
  { setting: string; reason: string }
> = Failure.define(
  'InvalidBenchSetting',
  (data: { setting: string; reason: string }) => `qunitx bench ${data.setting}: ${data.reason}`,
);

/**
 * No bench file among the inputs.
 *
 * ```ts
 * import { NoBenchFiles } from './bench.ts';
 *
 * NoBenchFiles({ inputs: ['benches'] }).message.startsWith('No bench modules found'); // true
 * ```
 */
export const NoBenchFiles: Failure.FailureFactory<'NoBenchFiles', { inputs: string[] }> =
  Failure.define(
    'NoBenchFiles',
    (data: { inputs: string[] }) =>
      `No bench modules found in ${data.inputs.join(', ')}: files named bench.ts, *_bench.ts or *.bench.ts (or .js, .jsx, .tsx, .mts, .mjs)`,
  );

// The flags that take a value, and the setting each sets.
const VALUE_FLAGS: Record<string, keyof BenchSettings> = {
  '--browser': 'browser',
  '--filter': 'filter',
  '-t': 'filter',
  '--ignore': 'ignore',
  '--reporter': 'format',
  '-r': 'format',
  '--save': 'save',
  '--compare': 'compare',
  '--threshold': 'threshold',
  '--min-delta': 'minDelta',
  '--retries': 'retries',
  '--warmup': 'warmup',
  '--time': 'time',
  '--cpu-throttle': 'cpuThrottle',
  '--profile': 'profile',
  '--port': 'port',
  '-p': 'port',
  '--timeout': 'timeout',
};
// The flags that are switches, and the setting each turns on.
const SWITCHES: Record<string, [keyof BenchSettings, unknown]> = {
  '--json': ['format', 'json'],
  '--no-run': ['noRun', true],
  '--permit-no-files': ['permitNoFiles', true],
  '--watch': ['watch', true],
  '-w': ['watch', true],
};
// The settings whose flags take a number, and `--min-delta`'s units in nanoseconds.
const NUMERIC_SETTINGS = new Set([
  'threshold',
  'retries',
  'warmup',
  'time',
  'cpuThrottle',
  'port',
  'timeout',
]);
const NANOSECONDS: Record<string, number> = { ns: 1, µs: 1e3, us: 1e3, ms: 1e6, s: 1e9 };
// Each setting's test, and what it expects, as the failure says it.
const SETTING_RULES: Record<string, [(value: unknown) => boolean, string]> = {
  cwd: [isText, 'a path'],
  browser: [
    (value) => value === 'chromium' || value === 'firefox' || value === 'webkit',
    'chromium, firefox or webkit',
  ],
  filter: [(value) => typeof value === 'string', 'a name, or /a regex/'],
  ignore: [(value) => Array.isArray(value) && value.every(isText), 'a list of paths or globs'],
  format: [
    (value) => Report.BENCH_FORMATS.includes(value as Report.BenchFormat),
    Report.BENCH_FORMATS.join(', '),
  ],
  save: [isText, 'a file path'],
  compare: [isText, 'a file path'],
  threshold: [isNumber(0), 'a percentage'],
  minDelta: [isNumber(0), 'a time, such as 500ns, 2µs or 1ms'],
  retries: [isWhole(0), 'a whole number of 0 or more'],
  warmup: [isNumber(0), 'milliseconds'],
  time: [(value) => isNumber(0)(value) && (value as number) > 0, 'milliseconds above 0'],
  cpuThrottle: [isNumber(1, 100), 'a slowdown from 1 to 100'],
  profile: [isText, 'a directory'],
  noRun: [isBoolean, 'true or false'],
  permitNoFiles: [isBoolean, 'true or false'],
  watch: [isBoolean, 'true or false'],
  port: [isWhole(1, 65_535), 'a port'],
  timeout: [isWhole(0), 'milliseconds'],
  console: [(value) => typeof value === 'object' && value !== null, 'a Console'],
  signal: [
    (value) => typeof AbortSignal !== 'undefined' && value instanceof AbortSignal,
    'an AbortSignal',
  ],
  onResult: [(value) => typeof value === 'function', 'a function'],
  inputs: [
    (value) => Array.isArray(value) && value.every(isText),
    'a list of files, folders or globs',
  ],
};

/**
 * Parses `qunitx bench`'s argv: its inputs, and the settings its flags give. A bare `--profile`
 * writes profiles to `tmp/bench-profiles`. `--min-delta` takes a time — `500ns`, `2µs` (or `2us`),
 * `1ms` — or nanoseconds.
 *
 * ```ts
 * import { parseArgs } from './bench.ts';
 *
 * const parsed = parseArgs(['benches', '--json', '--filter=/^render/', '--min-delta=2us'], {});
 * !(parsed instanceof Error) && [parsed.inputs, parsed.settings.format, parsed.settings.minDelta];
 * // [['benches'], 'json', 2000]
 * ```
 */
export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
):
  | { inputs: string[]; settings: BenchSettings; help: boolean }
  | Failure.Of<typeof InvalidBenchSetting> {
  const inputs: string[] = [];
  const settings: Record<string, unknown> = {};
  let help = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--') {
      inputs.push(...argv.slice(index + 1));
      break;
    } else if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (!argument.startsWith('-')) {
      inputs.push(argument);
    } else if (argument in SWITCHES) {
      const [setting, value] = SWITCHES[argument];
      settings[setting] = value;
    } else if (argument === '--profile') {
      settings.profile = 'tmp/bench-profiles';
    } else if (argument === '--trace-perf') {
      continue;
    } else {
      const equals = argument.indexOf('=');
      const flag = equals === -1 ? argument : argument.slice(0, equals);
      const setting = VALUE_FLAGS[flag];
      if (!setting) {
        return InvalidBenchSetting({
          setting: argument,
          reason: 'unknown flag (see qunitx bench --help)',
        });
      }
      const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
      if (value === undefined)
        return InvalidBenchSetting({ setting: flag, reason: 'needs a value' });
      settings[setting] =
        setting === 'ignore'
          ? [...((settings.ignore as string[]) ?? []), ...value.split(',')]
          : fromText(setting, value);
    }
  }
  if (!settings.browser && env.QUNITX_BROWSER) settings.browser = env.QUNITX_BROWSER;
  const invalid = checkSettings(settings);
  return invalid ?? { inputs, settings: settings as BenchSettings, help };
}

/**
 * The first setting of `settings` that will not do, as a failure; null when they all will. The
 * one rule the flags, `package.json#qunitx.bench` and the JS API are held to.
 *
 * ```ts
 * import { checkSettings } from './bench.ts';
 *
 * checkSettings({ threshold: 10, format: 'csv' }); // null
 * checkSettings({ retries: -1 })?.message; // 'qunitx bench retries: expected a whole number of 0 or more, got -1'
 * ```
 */
export function checkSettings(
  settings: Record<string, unknown>,
): Failure.Of<typeof InvalidBenchSetting> | null {
  // The first setting given that has no rule, or breaks its rule.
  const [setting, value] =
    Object.entries(settings).find(
      ([setting, value]) => value !== undefined && !SETTING_RULES[setting]?.[0](value),
    ) ?? [];
  if (setting !== undefined) {
    const rule = SETTING_RULES[setting];
    return InvalidBenchSetting({
      setting,
      reason: rule
        ? `expected ${rule[1]}, got ${JSON.stringify(value) ?? String(value)}`
        : `is not a setting; expected ${Object.keys(SETTING_RULES).join(', ')}`,
    });
  }
  const devTools =
    settings.profile !== undefined
      ? 'profile'
      : settings.cpuThrottle !== undefined
        ? 'cpuThrottle'
        : null;
  return devTools && (settings.browser ?? 'chromium') !== 'chromium'
    ? InvalidBenchSetting({
        setting: devTools,
        reason: `needs chromium: ${settings.browser} has no DevTools protocol to ask`,
      })
    : null;
}

/**
 * The bench files `inputs` name, sorted: a file as it is, a folder's bench files at any depth
 * (`node_modules`, `.git`, `tmp`, `dist` and `coverage` skipped), a glob's matches, a URL as it
 * is. No inputs is the current folder. `ignore` leaves files, folders and globs out.
 *
 * ```ts
 * import { benchFiles } from './bench.ts';
 *
 * // Defined, not invoked: reads the file system.
 * async function found() {
 *   return await benchFiles(['benches'], process.cwd(), []); // ['/project/benches/render.bench.ts', …]
 * }
 * ```
 */
export async function benchFiles(
  inputs: string[],
  cwd: string,
  ignore: string[],
): Promise<string[]> {
  const isGlob = (pattern: string) => /[*?[{]/.test(pattern);
  const globbed = async (pattern: string) =>
    (await Array.fromAsync(fs.promises.glob(pattern, { cwd }))).map((file) =>
      path.resolve(cwd, file),
    );
  // A folder's bench files at any depth, its subfolders read at once.
  const walk = async (directory: string): Promise<string[]> => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
    const found = await Promise.all(
      entries.map((entry) => {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : walk(file);
        return BENCH_FILE.test(entry.name) ? [file] : [];
      }),
    );
    return found.flat();
  };
  const [ignored, found] = await Promise.all([
    Promise.all(
      ignore.map(async (pattern) =>
        isGlob(pattern) ? new Set(await globbed(pattern)) : path.resolve(cwd, pattern),
      ),
    ),
    Promise.all(
      (inputs.length ? inputs : ['.']).map(async (input) => {
        if (isRemoteInput(input)) return [input];
        if (isGlob(input)) return await globbed(input);
        const absolute = path.resolve(cwd, input);
        const stat = await fs.promises.stat(absolute).catch(() => null);
        return stat?.isDirectory() ? await walk(absolute) : stat ? [absolute] : [];
      }),
    ),
  ]);
  const isIgnored = (file: string) =>
    ignored.some((entry) =>
      typeof entry === 'string'
        ? file === entry || file.startsWith(entry + path.sep)
        : entry.has(file),
    );
  return [...new Set(found.flat())]
    .filter((file) => isRemoteInput(file) || !isIgnored(file))
    .sort();
}

/**
 * Runs `qunitx bench`: finds the bench files, measures each in a fresh page of a real browser,
 * prints the report, compares it with a baseline when asked, and saves it when asked. With
 * `watch`, measures again on every change, and never resolves.
 *
 * ```ts
 * import { run } from './bench.ts';
 *
 * // Defined, not invoked: launches a browser.
 * async function measure() {
 *   const result = await run(['benches'], { browser: 'firefox', format: 'json' });
 *   return result.report.benches.length;
 * }
 * ```
 */
export async function run(inputs: string[], given: BenchSettings = {}): Promise<BenchResult> {
  const prepared = await prepare(inputs, given);
  if (!prepared.files.length || prepared.settings.signal?.aborted) return prepared.empty;
  const bench = await launch(prepared);
  try {
    if (prepared.settings.noRun) return bench.check();
    if (!prepared.settings.watch) return await bench.measure();
    return await watchLoop([...new Set(await bench.watchDirectories())], async () => {
      await bench.rebuild();
      await bench.measure();
      prepared.out.error(
        `# ${blue('Watching')} ${prepared.files.length} bench file${prepared.files.length === 1 ? '' : 's'}\n`,
      );
    });
  } finally {
    await bench.close();
  }
}

/**
 * A run's settings resolved — flags or options over `package.json#qunitx.bench` — with its bench
 * files, its baseline, and how to bundle a file: everything decided before a browser is launched.
 * `empty` is the result of a run that measures nothing.
 *
 * ```ts
 * import type { PreparedBench } from './bench.ts';
 *
 * function count(prepared: PreparedBench) {
 *   return prepared.files.length;
 * }
 * ```
 */
export interface PreparedBench {
  /** Every setting, resolved. */
  settings: BenchSettings & {
    browser: 'chromium' | 'firefox' | 'webkit';
    format: Report.BenchFormat;
  };
  /** Where inputs resolved from. */
  cwd: string;
  /** The project around it. */
  projectRoot: string;
  /** The bench files. */
  files: string[];
  /** `compare`'s baseline, or null. */
  baseline: Compare.BaselineEntry[] | null;
  /** Where the report goes. */
  out: Console;
  /** Bundles one bench file. */
  build: (file: string) => Promise<Bundle>;
  /** The result of measuring nothing. */
  empty: BenchResult;
}

/**
 * Resolves a run: settings (flags or options over `package.json#qunitx.bench`), bench files,
 * baseline and plugins. Throws {@link NoBenchFiles} when there are none, unless `permitNoFiles`,
 * and {@link InvalidBenchSetting} for a setting or baseline that will not do.
 *
 * ```ts
 * import { prepare } from './bench.ts';
 *
 * // Defined, not invoked: reads the file system.
 * async function files() {
 *   return (await prepare(['benches'], {})).files;
 * }
 * ```
 */
export async function prepare(inputs: string[], given: BenchSettings = {}): Promise<PreparedBench> {
  const cwd = given.cwd ?? process.cwd();
  const projectRoot = await findProjectRoot(cwd).catch(() => cwd);
  const manifest: { qunitx?: unknown } = await fs.promises
    .readFile(path.join(projectRoot, 'package.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => ({}));
  const configured =
    (manifest.qunitx as { bench?: Record<string, unknown> } | undefined)?.bench ?? {};
  const { inputs: configuredInputs, ...fromManifest } = configured as { inputs?: string[] };
  const invalid = checkSettings(configured);
  if (invalid) {
    throw InvalidBenchSetting({
      setting: `in package.json#qunitx.bench: ${invalid.data.setting}`,
      reason: invalid.data.reason,
    });
  }
  const merged = {
    ...(fromManifest as BenchSettings),
    ...Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined)),
  } as BenchSettings;
  const fromGiven = checkSettings({ ...merged });
  if (fromGiven) throw fromGiven;
  const settings = {
    ...merged,
    browser: merged.browser ?? 'chromium',
    format: merged.format ?? 'pretty',
  };
  const out = settings.console ?? processConsole;
  // Relative to the project when package.json gave them, to where it runs when the command did.
  const files = await benchFiles(
    inputs.length
      ? inputs
      : (configuredInputs ?? []).map((input) => path.resolve(projectRoot, input)),
    cwd,
    (settings.ignore ?? []).map((pattern) => path.resolve(cwd, pattern)),
  );
  if (!files.length && !settings.permitNoFiles) {
    throw NoBenchFiles({ inputs: inputs.length ? inputs : (configuredInputs ?? ['.']) });
  }
  const [baseline, plugins] = await Promise.all([
    settings.compare ? readBaselineFile(path.resolve(cwd, settings.compare), projectRoot) : null,
    resolvePlugins((manifest.qunitx as { plugins?: unknown } | undefined)?.plugins, projectRoot)
      .result()
      .then((resolved) => {
        if (Failure.is(resolved)) throw resolved;
        return resolved;
      }),
  ]);
  return {
    settings,
    cwd,
    projectRoot,
    files,
    baseline,
    out,
    build: (file) => bundle(file, { cwd, projectRoot, browser: settings.browser, plugins }),
    empty: {
      ok: !settings.signal?.aborted,
      exitCode: settings.signal?.aborted ? 1 : 0,
      aborted: Boolean(settings.signal?.aborted),
      report: {
        version: 1,
        runtime: RUNTIMES[settings.browser],
        cpu: os.cpus()[0]?.model?.trim() || 'unknown',
        benches: [],
      },
      comparison: null,
      files,
    },
  };
}

/**
 * A prepared run with its files bundled, a browser launched and a server bound: measured as many
 * times as asked, until closed.
 *
 * ```ts
 * import type { LaunchedBench } from './bench.ts';
 *
 * // Defined, not invoked: needs a launched browser.
 * async function twice(bench: LaunchedBench) {
 *   const first = await bench.measure();
 *   await bench.rebuild();
 *   return [first, await bench.measure()];
 * }
 * ```
 */
export interface LaunchedBench {
  /** Measures every file once, prints and saves as the settings say, and resolves with it. */
  measure(): Promise<BenchResult>;
  /** Reports which files build, measuring nothing: `noRun`. */
  check(): BenchResult;
  /** Bundles every file again, as it now is on disk. */
  rebuild(): Promise<void>;
  /** The directories of the files the bundles were made from, for a watcher. */
  watchDirectories(): Promise<string[]>;
  /** Closes the browser and the server. */
  close(): Promise<void>;
}

/**
 * Bundles a prepared run's files, launches its browser and binds its server.
 *
 * ```ts
 * import { launch, prepare } from './bench.ts';
 *
 * // Defined, not invoked: launches a browser.
 * async function once() {
 *   const bench = await launch(await prepare(['benches'], {}));
 *   try {
 *     return await bench.measure();
 *   } finally {
 *     await bench.close();
 *   }
 * }
 * ```
 */
export async function launch(prepared: PreparedBench): Promise<LaunchedBench> {
  const { settings, cwd, projectRoot, files, baseline, out } = prepared;
  let bundles = await Promise.all(files.map(prepared.build));
  const rebuild = async () => void (bundles = await Promise.all(files.map(prepared.build)));
  const watchDirectories = () =>
    realWatchDirectories(bundles.flatMap((built) => built.watchDirectories));
  const reportBroken = () => {
    for (const built of bundles) if (built.error) out.error(`${red('error')}: ${built.error}\n`);
  };
  const check = (): BenchResult => {
    reportBroken();
    for (const built of bundles) {
      if (!built.error) out.log(`${blue('Check')} ${shown(built.file, cwd)}\n`);
    }
    const broken = bundles.some((built) => built.error);
    return { ...prepared.empty, ok: !broken, exitCode: broken ? 1 : 0 };
  };
  if (settings.noRun) {
    return {
      check,
      measure: () => Promise.resolve(check()),
      rebuild,
      watchDirectories,
      close: () => Promise.resolve(),
    };
  }

  const server = new HTTPServer();
  let current: { bundle: Bundle; filter: string | undefined } | null = null;
  const timing: BenchTiming = {
    warmupMs: settings.warmup ?? 100,
    sampleMs: 10,
    budgetMs: settings.time ?? 500,
    minSamples: 10,
    maxSamples: 100_000,
  };
  const serve =
    (type: string, body: () => string): RouteHandler =>
    (_request, response) => {
      for (const [name, value] of Object.entries({
        ...DEFAULT_HTTP_HEADERS,
        'Content-Type': type,
      })) {
        response.setHeader(name, value);
      }
      response.end(body());
    };
  server.get(
    '/',
    serve('text/html; charset=utf-8', () =>
      pageHTML(current!.bundle.file, current!.filter, timing),
    ),
  );
  server.get(
    BUNDLE_ROUTE,
    serve('text/javascript; charset=utf-8', () => current!.bundle.code),
  );
  server.get('/favicon.ico', (_request, response) => {
    response.statusCode = 204;
    response.end();
  });

  const browser = await Browser.launch({ browser: settings.browser });
  const config = { port: settings.port ?? 1234, portExplicit: settings.port !== undefined };
  try {
    await bindServerToPort(server, config);
  } catch (error) {
    await closeCompletely({ server: server.close(), browser: browser.close() });
    throw error;
  }
  const origin = `http://localhost:${config.port}/`;
  const runtime = `${RUNTIMES[settings.browser]}/${browser.version()} ${process.arch}-${process.platform}`;
  const { cpu } = prepared.empty.report;
  const rule = { threshold: settings.threshold ?? 10, minDelta: settings.minDelta ?? 1_000 };
  const profiles = settings.profile ? path.resolve(cwd, settings.profile) : null;
  if (profiles) await fs.promises.mkdir(profiles, { recursive: true });

  // One file, measured in a page of its own: a fresh heap and JIT, nothing left by the last file.
  const measureOne = async (built: Bundle, filter: string | undefined, retry: boolean) => {
    current = { bundle: built, filter };
    return await measureFile(browser, origin, built, {
      ...settings,
      filter,
      projectRoot,
      out,
      timing,
      profiles,
      // A retry's measurements replace the first only when faster, so they are not news yet.
      onResult: retry ? undefined : settings.onResult,
    });
  };

  // One file's outcome: measured, its regressions measured again, and printed when pretty.
  const outcomeOf = async (built: Bundle): Promise<FileOutcome> => {
    const measured = await measureOne(built, settings.filter, false);
    if (measured.error) {
      out.error(`${red('error')}: ${shown(built.file, cwd)}\n${measured.error}\n`);
      return { ...NOTHING_MEASURED, failed: true, aborted: measured.aborted };
    }
    let report: Report.BenchReport = { version: 1, runtime, cpu, benches: measured.benches };
    let comparison = baseline ? Compare.compare(report, baseline, rule, projectRoot) : null;
    // A regression is measured again before it counts, keeping each bench's best: the least
    // disturbed measurement of the same code.
    for (
      let attempt = 0;
      comparison?.regressions.length &&
      attempt < (settings.retries ?? 2) &&
      !settings.signal?.aborted;
      attempt++
    ) {
      const again = await measureOne(
        built,
        Compare.exactly(comparison.regressions.map((change) => change.bench.name)),
        true,
      );
      report = Compare.fastestOf(report, again.benches);
      comparison = Compare.compare(report, baseline!, rule, projectRoot);
    }
    if (settings.format === 'pretty') {
      out.log(Report.pretty({ origin: built.origin, benches: report.benches }, comparison));
      warn(report.benches, out);
    }
    return {
      benches: report.benches,
      changes: comparison?.changes ?? [],
      failed: report.benches.some((bench) => 'failed' in bench.results[0]),
      onlyUsed: measured.onlyUsed,
      aborted: measured.aborted,
    };
  };

  const measure = async (): Promise<BenchResult> => {
    reportBroken();
    if (settings.format === 'pretty')
      out.log(Report.header({ version: 1, runtime, cpu, benches: [] }));
    // One file after another, as one page measures at a time; an abort stops between them.
    const outcomes: FileOutcome[] = [];
    for (const built of bundles.filter((built) => !built.error)) {
      const outcome = settings.signal?.aborted
        ? { ...NOTHING_MEASURED, aborted: true }
        : await outcomeOf(built);
      outcomes.push(outcome);
      if (outcome.aborted) break;
    }

    const report: Report.BenchReport = {
      version: 1,
      runtime,
      cpu,
      benches: outcomes.flatMap((outcome) => outcome.benches),
    };
    const aborted = outcomes.some((outcome) => outcome.aborted);
    const onlyUsed = outcomes.some((outcome) => outcome.onlyUsed);
    const failed =
      bundles.some((built) => built.error) || outcomes.some((outcome) => outcome.failed);
    // One comparison of the whole run, from each file's, so the verdict covers every file.
    const changes = outcomes.flatMap((outcome) => outcome.changes);
    const comparison = baseline
      ? {
          ...Compare.compare(report, baseline, rule, projectRoot),
          changes,
          regressions: changes.filter((change) => change.regressed),
        }
      : null;
    if (settings.format !== 'pretty') out.log(Report.render(report, settings.format, comparison));
    if (comparison) out.error(verdict(comparison, settings));
    if (aborted) out.error(`${red('error')}: Bench aborted\n`);
    else if (onlyUsed)
      out.error(`${red('error')}: Bench failed because the "only" option was used\n`);
    else if (failed) out.error(`${red('error')}: Bench failed\n`);
    // A run cut short is no baseline: saving it would make every bench it skipped "new".
    if (settings.save && !aborted) {
      const target = path.resolve(cwd, settings.save);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
    }
    const exitCode = aborted || onlyUsed || failed || comparison?.regressions.length ? 1 : 0;
    return { ok: exitCode === 0, exitCode, aborted, report, comparison, files };
  };

  return {
    measure,
    check,
    rebuild,
    watchDirectories,
    close: async () => {
      const pending = await closeCompletely({
        server: server.close(),
        browser: browser.close(),
        prelaunch: shutdownPrelaunch(),
      });
      if (pending.length) out.error(`# qunitx: ${pending.join(', ')} never finished closing\n`);
    },
  };
}

// What one file added to a run: its benches and their changes from the baseline, and whether it
// failed, used `only`, or was cut short.
interface FileOutcome {
  benches: BenchEntry[];
  changes: Compare.Comparison['changes'];
  failed: boolean;
  onlyUsed: boolean;
  aborted: boolean;
}

// deno bench's warnings for a timing finer than the clock it was taken with.
function warn(benches: BenchEntry[], out: Console): void {
  for (const bench of benches) {
    const result = bench.results[0];
    if (!('ok' in result) || result.ok.avg >= 10_000) continue;
    if (result.ok.usedExplicitTimers) {
      out.error(
        `${yellow(`Warning: start() and end() calls in "${bench.name}" are ignored because it averages less\nthan 10µs per iteration. Remove them for better results.`)}\n`,
      );
    } else if (result.ok.min === 0) {
      out.error(
        `${yellow(`Warning: "${bench.name}" times each of its n iterations alone, finer than this browser's clock:\nleave n out to have it timed in batches.`)}\n`,
      );
    }
  }
}

/**
 * One bench file, bundled: its code and source map, or why it would not build.
 *
 * ```ts
 * const built: Bundle = { file: '/p/a.bench.ts', origin: 'file:///p/a.bench.ts', code: '', decoder: null, watchDirectories: [], error: null };
 * ```
 */
export interface Bundle {
  /** The bench file. */
  file: string;
  /** Its URL, as its benches report it. */
  origin: string;
  /** The bundle. */
  code: string;
  /** Its source map. */
  decoder: SourceMapDecoder | null;
  /** The folders of the files it was made from. */
  watchDirectories: string[];
  /** Why it would not build, or null. */
  error: string | null;
}

// Bundles a bench file behind a wrapper that imports it and runs what it declared. `Deno.bench`
// is compiled to the page's `bench`, so the same file runs under `deno bench` and here.
async function bundle(
  file: string,
  options: { cwd: string; projectRoot: string; browser: string; plugins: esbuild.Plugin[] },
): Promise<Bundle> {
  const origin = isRemoteInput(file) ? file : pathToFileURL(file).href;
  const entry = isRemoteInput(file) ? { path: file, namespace: REMOTE_NAMESPACE } : { path: file };
  try {
    const result = await esbuild.build({
      stdin: { contents: wrapperSource(), resolveDir: options.cwd },
      absWorkingDir: options.cwd,
      nodePaths: ancestorNodeModules(options.cwd),
      bundle: true,
      write: false,
      metafile: true,
      logLevel: 'silent',
      format: 'esm',
      outdir: options.projectRoot,
      keepNames: true,
      legalComments: 'none',
      target: [TARGETS[options.browser]],
      sourcemap: 'inline',
      jsx: 'automatic',
      define: { 'Deno.bench': 'globalThis.bench' },
      plugins: [
        {
          name: 'qunitx-bench-entry',
          setup(build) {
            build.onResolve({ filter: new RegExp(`^${ENTRY_SPECIFIER}$`) }, () => entry);
          },
        },
        remoteModulePlugin(options.cwd),
        qunitxRuntimePlugin(options.cwd),
        ...options.plugins,
      ],
    });
    const code = result.outputFiles[0].text;
    return {
      file,
      origin,
      code,
      decoder: SourceMap.extractInline(code, options.projectRoot),
      watchDirectories: watchDirectoriesFrom(Object.keys(result.metafile.inputs), options.cwd),
      error: null,
    };
  } catch (error) {
    const messages = (error as { errors?: esbuild.Message[] }).errors ?? [];
    // Node's own modules, which no browser has: one explanation for them all rather than a line
    // per import, as a file written for `deno bench` on node's APIs imports dozens. It is the whole
    // answer, too: what else would not resolve is node-only code that cannot run here either.
    const fromNode = messages.filter((message) =>
      isBuiltin(UNRESOLVED.exec(message.text)?.[1] ?? ''),
    );
    const modules = [...new Set(fromNode.map((message) => UNRESOLVED.exec(message.text)![1]))];
    const reason =
      fromNode.length > 0
        ? `it imports node's own modules (${modules.length > 4 ? `${modules.slice(0, 4).join(', ')} and ${modules.length - 4} more` : modules.join(', ')}, first in ${fromNode[0].location?.file}), which a browser does not have.\nRun it with \`deno bench\`, or leave it out: --ignore=${shown(file, options.cwd)}`
        : messages.length > 0
          ? messages
              .map(
                (message) =>
                  `${message.location ? `${message.location.file}:${message.location.line}:${message.location.column}: ` : ''}${message.text}`,
              )
              .join('\n')
          : String(error);
    return {
      file,
      origin,
      code: '',
      decoder: null,
      watchDirectories: [],
      error: `${shown(file, options.cwd)} would not build: ${reason}`,
    };
  }
}

// Navigates a fresh page to the file and waits for its benches, printing their console output,
// profiling each and throttling the CPU when asked.
async function measureFile(
  browser: PlaywrightBrowser,
  url: string,
  built: Bundle,
  settings: BenchSettings & {
    browser: string;
    filter: string | undefined;
    projectRoot: string;
    out: Console;
    timing: BenchTiming;
    /** The directory each bench's CPU profile is written to, or null. */
    profiles: string | null;
  },
): Promise<{ benches: BenchEntry[]; onlyUsed: boolean; aborted: boolean; error: string | null }> {
  const { profiles } = settings;
  const context = await browser.newContext();
  const page: Page = await context.newPage();
  // Back to the file a bench was written in, without the frames of the harness running it.
  const mapped = (text: string) =>
    (built.decoder
      ? SourceMap.resolveStack(text, built.decoder, settings.projectRoot).resolvedStack
      : text
    )
      .split('\n')
      // The page's own frames — the harness inline in it, and the wrapper — in V8's `at f (url)`
      // and Firefox's and Safari's `f@url` alike. The bench file's own frames are kept.
      .filter(
        (line) =>
          line.trim() !== '' && !/(?:<stdin>|https?:\/\/localhost:\d+\/):\d+:\d+\)?\s*$/.test(line),
      )
      .join('\n');
  const uncaught: string[] = [];
  page.on('console', (message) => {
    void Promise.all(message.args().map((arg) => arg.jsonValue()))
      .catch(() => null)
      .then((args) =>
        settings.out.error(`${mapped(args?.length ? format(...args) : message.text())}\n`),
      );
  });
  page.on('pageerror', (error) => uncaught.push(mapped(error.stack ?? String(error))));
  // Each bench as the page hands it over, so an abort mid-file still has what was measured.
  const streamed: BenchEntry[] = [];
  const withSourceStack = (bench: BenchEntry): BenchEntry => {
    const result = bench.results[0];
    return 'failed' in result
      ? {
          ...bench,
          results: [{ failed: { ...result.failed, stack: mapped(result.failed.stack) } }],
        }
      : bench;
  };
  // Mid-bench, the page is closed outright: the bench in flight has nothing to give back.
  let abortedMidBench = false;
  const stop = () => {
    abortedMidBench = true;
    void context.close().catch(() => {});
  };
  settings.signal?.addEventListener('abort', stop, { once: true });
  try {
    const cdp = settings.cpuThrottle || profiles ? await context.newCDPSession(page) : null;
    if (cdp && settings.cpuThrottle && settings.cpuThrottle > 1) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: settings.cpuThrottle });
    }
    if (cdp && profiles) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    }
    // Told of each bench between measurements, never during one: `false` stops the run there.
    await page.exposeFunction('__qunitxBenchStarted', async () => {
      if (settings.signal?.aborted) return false;
      if (cdp && profiles) await cdp.send('Profiler.start');
      return true;
    });
    await page.exposeFunction('__qunitxBenchFinished', async (entry: BenchEntry) => {
      if (cdp && profiles) {
        const { profile } = await cdp.send('Profiler.stop');
        const name = `${path.basename(built.file).replace(/\.[^.]+$/, '')}--${entry.name.replace(/[^\w.-]+/g, '-')}.cpuprofile`;
        await fs.promises.writeFile(path.join(profiles, name), JSON.stringify(profile));
      }
      const mappedEntry = withSourceStack(entry);
      streamed.push(mappedEntry);
      settings.onResult?.(mappedEntry);
    });
    await page.goto(url, { waitUntil: 'commit', timeout: NAVIGATION_TIMEOUT_MS });
    const handle = await page.waitForFunction(
      () => (globalThis as { __qunitxBenchDone?: unknown }).__qunitxBenchDone ?? null,
      null,
      { timeout: settings.timeout ?? 0, polling: 100 },
    );
    const done = (await handle.jsonValue()) as
      | { ok: true; benches: BenchEntry[]; onlyUsed: boolean; aborted: boolean }
      | { ok: false; stack: string };
    if (!done.ok)
      return { benches: [], onlyUsed: false, aborted: false, error: mapped(done.stack) };
    return {
      benches: done.benches.map(withSourceStack),
      onlyUsed: done.onlyUsed,
      aborted: done.aborted,
      error: uncaught.length ? uncaught.join('\n') : null,
    };
  } catch (error) {
    if (abortedMidBench) return { benches: streamed, onlyUsed: false, aborted: true, error: null };
    throw error;
  } finally {
    settings.signal?.removeEventListener('abort', stop);
    await context.close().catch(() => {});
  }
}

function pageHTML(file: string, filter: string | undefined, timing: BenchTiming): string {
  const origin = isRemoteInput(file) ? file : pathToFileURL(file).href;
  const settings = JSON.stringify({ origin, timing }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>qunitx bench · ${path.basename(file).replace(/</g, '&lt;')}</title></head>
<body>
<script>
globalThis.__qunitxBench = (${installBench.toString()})({ ...${settings}, highPrecision: globalThis.crossOriginIsolated === true });
globalThis.__qunitxBenchFilter = ${JSON.stringify(filter ?? '').replace(/</g, '\\u003c')};
globalThis.bench = globalThis.__qunitxBench.bench;
</script>
<script type="module" src="${BUNDLE_ROUTE}"></script>
</body>
</html>
`;
}

// The entry esbuild compiles: the bench file, then its benches run and handed back.
function wrapperSource(): string {
  return `globalThis.__qunitxBenchDone = null;
(async () => {
  try {
    await import(${JSON.stringify(ENTRY_SPECIFIER)});
    const result = await globalThis.__qunitxBench.run({
      filter: globalThis.__qunitxBenchFilter || undefined,
      hooks: {
        started: (name) => globalThis.__qunitxBenchStarted?.(name),
        finished: (entry) => globalThis.__qunitxBenchFinished?.(entry),
      },
    });
    globalThis.__qunitxBenchDone = { ok: true, ...result };
  } catch (error) {
    globalThis.__qunitxBenchDone = { ok: false, stack: String((error && error.stack) || error) };
  }
})();
`;
}

function verdict(comparison: Compare.Comparison, settings: BenchSettings): string {
  const against = settings.compare ? ` against ${settings.compare}` : '';
  const missing = comparison.missing.length
    ? `# ${comparison.missing.length} baseline bench${comparison.missing.length === 1 ? '' : 'es'} did not run: ${comparison.missing.map((entry) => entry.name).join(', ')}\n`
    : '';
  if (!comparison.regressions.length) {
    return `# ${blue('No regressions')}${against}: ${comparison.changes.length} bench${comparison.changes.length === 1 ? '' : 'es'} compared\n${missing}`;
  }
  const lines = comparison.regressions.map(
    (change) =>
      `#   ${change.bench.name}: ${Report.duration(change.base)} → ${Report.duration((change.bench.results[0] as { ok: { avg: number } }).ok.avg)} (+${change.percent.toFixed(1)}%, over ${change.threshold}%)`,
  );
  return `${red(`# ${comparison.regressions.length} regression${comparison.regressions.length === 1 ? '' : 's'}`)}${against}:\n${lines.join('\n')}\n${missing}`;
}

async function readBaselineFile(
  file: string,
  projectRoot: string,
): Promise<Compare.BaselineEntry[]> {
  const json = await fs.promises
    .readFile(file, 'utf8')
    .then(JSON.parse)
    .catch((error: Error) => {
      throw InvalidBenchSetting({
        setting: 'compare',
        reason: `cannot read ${file}: ${error.message}`,
      });
    });
  try {
    return Compare.readBaseline(json, projectRoot);
  } catch (error) {
    throw InvalidBenchSetting({
      setting: 'compare',
      reason: `${file} is ${(error as Error).message}`,
    });
  }
}

function fromText(setting: keyof BenchSettings, value: string): unknown {
  if (setting === 'minDelta') {
    // `500ns`, `2µs`, `2us`, `1ms`, `1s`, or a bare number of nanoseconds.
    const match = /^\s*(\d+(?:\.\d+)?)\s*(ns|µs|us|ms|s)?\s*$/.exec(value);
    return match ? Number(match[1]) * NANOSECONDS[match[2] ?? 'ns'] : value;
  }
  const number = Number(value.replace(/%$/, ''));
  return NUMERIC_SETTINGS.has(setting) && value.trim() !== '' && !Number.isNaN(number)
    ? number
    : value;
}

function isText(value: unknown): boolean {
  return typeof value === 'string' && value !== '';
}

function isBoolean(value: unknown): boolean {
  return typeof value === 'boolean';
}

function isNumber(min: number, max = Infinity): (value: unknown) => boolean {
  return (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isWhole(min: number, max = Infinity): (value: unknown) => boolean {
  return (value) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function shown(file: string, cwd: string): string {
  return isRemoteInput(file) ? file : path.relative(cwd, file) || file;
}

// Every `node_modules` up from `dir`, so a bench outside the project still finds its packages.
function ancestorNodeModules(dir: string): string[] {
  return dir
    .split(path.sep)
    .map((_, index, parts) =>
      path.join(parts.slice(0, parts.length - index).join(path.sep) || path.sep, 'node_modules'),
    );
}
