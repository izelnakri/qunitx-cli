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
import { HTTPServer } from '../web/index.ts';
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
}

/**
 * What a run produced: its report in `deno bench --json`'s shape, how it compared with the
 * baseline, the files that ran, and the exit code the command line exits with — 1 for a failed
 * bench, a regression, a file that would not build, or an `only` left in.
 *
 * ```ts
 * const result: BenchResult = { ok: true, exitCode: 0, report: { version: 1, runtime: '', cpu: '', benches: [] }, comparison: null, files: [] };
 * ```
 */
export interface BenchResult {
  /** True when the exit code is 0. */
  ok: boolean;
  /** 0 or 1. */
  exitCode: number;
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
  const whole = (value: unknown, min: number) =>
    Number.isInteger(value) && (value as number) >= min;
  const positive = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;
  const text = (value: unknown) => typeof value === 'string' && value !== '';
  const rules: Record<string, [(value: unknown) => boolean, string]> = {
    cwd: [text, 'a path'],
    browser: [
      (value) => ['chromium', 'firefox', 'webkit'].includes(value as string),
      'chromium, firefox or webkit',
    ],
    filter: [(value) => typeof value === 'string', 'a name, or /a regex/'],
    ignore: [(value) => Array.isArray(value) && value.every(text), 'a list of paths or globs'],
    format: [
      (value) => Report.BENCH_FORMATS.includes(value as Report.BenchFormat),
      Report.BENCH_FORMATS.join(', '),
    ],
    save: [text, 'a file path'],
    compare: [text, 'a file path'],
    threshold: [
      (value) => typeof value === 'number' && value >= 0 && Number.isFinite(value),
      'a percentage',
    ],
    minDelta: [
      (value) => typeof value === 'number' && value >= 0 && Number.isFinite(value),
      'a time, such as 500ns, 2µs or 1ms',
    ],
    retries: [(value) => whole(value, 0), 'a whole number of 0 or more'],
    warmup: [
      (value) => typeof value === 'number' && value >= 0 && Number.isFinite(value),
      'milliseconds',
    ],
    time: [positive, 'milliseconds above 0'],
    cpuThrottle: [
      (value) => typeof value === 'number' && value >= 1 && value <= 100,
      'a slowdown from 1 to 100',
    ],
    profile: [text, 'a directory'],
    noRun: [(value) => typeof value === 'boolean', 'true or false'],
    permitNoFiles: [(value) => typeof value === 'boolean', 'true or false'],
    watch: [(value) => typeof value === 'boolean', 'true or false'],
    port: [(value) => whole(value, 1) && (value as number) < 65536, 'a port'],
    timeout: [(value) => whole(value, 0), 'milliseconds'],
    console: [(value) => typeof value === 'object' && value !== null, 'a Console'],
    inputs: [
      (value) => Array.isArray(value) && value.every(text),
      'a list of files, folders or globs',
    ],
  };
  for (const [setting, value] of Object.entries(settings)) {
    if (value === undefined) continue;
    const rule = rules[setting];
    if (!rule) {
      return InvalidBenchSetting({
        setting,
        reason: `is not a setting; expected ${Object.keys(rules).join(', ')}`,
      });
    }
    if (!rule[0](value)) {
      return InvalidBenchSetting({
        setting,
        reason: `expected ${rule[1]}, got ${JSON.stringify(value) ?? String(value)}`,
      });
    }
  }
  if (
    (settings.cpuThrottle !== undefined || settings.profile !== undefined) &&
    (settings.browser ?? 'chromium') !== 'chromium'
  ) {
    return InvalidBenchSetting({
      setting: settings.profile !== undefined ? 'profile' : 'cpuThrottle',
      reason: `needs chromium: ${settings.browser} has no DevTools protocol to ask`,
    });
  }
  return null;
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
  const found = new Set<string>();
  const ignored = await Promise.all(
    ignore.map(async (pattern) =>
      /[*?[{]/.test(pattern)
        ? new Set(
            (await Array.fromAsync(fs.promises.glob(pattern, { cwd }))).map((file) =>
              path.resolve(cwd, file),
            ),
          )
        : path.resolve(cwd, pattern),
    ),
  );
  const isIgnored = (file: string) =>
    ignored.some((entry) =>
      typeof entry === 'string'
        ? file === entry || file.startsWith(entry + path.sep)
        : entry.has(file),
    );
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(file);
      } else if (BENCH_FILE.test(entry.name)) {
        found.add(file);
      }
    }
  };
  for (const input of inputs.length ? inputs : ['.']) {
    if (isRemoteInput(input)) {
      found.add(input);
    } else if (/[*?[{]/.test(input)) {
      for await (const file of fs.promises.glob(input, { cwd })) found.add(path.resolve(cwd, file));
    } else {
      const absolute = path.resolve(cwd, input);
      const stat = await fs.promises.stat(absolute).catch(() => null);
      if (stat?.isDirectory()) await walk(absolute);
      else if (stat) found.add(absolute);
    }
  }
  return [...found].filter((file) => isRemoteInput(file) || !isIgnored(file)).sort();
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
  const cwd = given.cwd ?? process.cwd();
  const projectRoot = await findProjectRoot(cwd).catch(() => cwd);
  const manifest = readManifest(projectRoot);
  const configured =
    (manifest.qunitx as { bench?: Record<string, unknown> } | undefined)?.bench ?? {};
  const { inputs: configuredInputs, ...fromManifest } = configured as { inputs?: string[] };
  const invalid = checkSettings(configured);
  if (invalid)
    throw InvalidBenchSetting({
      setting: `in package.json#qunitx.bench: ${invalid.data.setting}`,
      reason: invalid.data.reason,
    });
  const settings = { ...(fromManifest as BenchSettings), ...withoutUndefined(given) };
  const fromGiven = checkSettings({ ...settings });
  if (fromGiven) throw fromGiven;
  const out = settings.console ?? processConsole;
  const format = settings.format ?? 'pretty';
  const browserName = settings.browser ?? 'chromium';
  // Relative to the project when package.json gave them, to where it runs when the command did.
  const files = await benchFiles(
    inputs.length
      ? inputs
      : (configuredInputs ?? []).map((input) => path.resolve(projectRoot, input)),
    cwd,
    (settings.ignore ?? []).map((pattern) => path.resolve(cwd, pattern)),
  );
  if (!files.length) {
    if (settings.permitNoFiles) {
      return { ok: true, exitCode: 0, report: emptyReport(browserName), comparison: null, files };
    }
    throw NoBenchFiles({ inputs: inputs.length ? inputs : (configuredInputs ?? ['.']) });
  }
  const baseline = settings.compare
    ? readBaselineFile(path.resolve(cwd, settings.compare), projectRoot)
    : null;
  const plugins = await resolvePlugins(
    (manifest.qunitx as { plugins?: unknown } | undefined)?.plugins,
    projectRoot,
  )
    .result()
    .then((resolved) => {
      if (Failure.is(resolved)) throw resolved;
      return resolved;
    });
  const build = (file: string) => bundle(file, { cwd, projectRoot, browser: browserName, plugins });

  let bundles = await Promise.all(files.map(build));
  const broken = bundles.filter((built) => built.error);
  for (const built of broken) out.error(`${red('error')}: ${built.error}\n`);
  if (settings.noRun) {
    for (const built of bundles)
      if (!built.error) out.log(`${blue('Check')} ${shown(built.file, cwd)}\n`);
    return {
      ok: !broken.length,
      exitCode: broken.length ? 1 : 0,
      report: emptyReport(browserName),
      comparison: null,
      files,
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
  server.get('/', (_request, response) => {
    for (const [name, value] of Object.entries(DEFAULT_HTTP_HEADERS))
      response.setHeader(name, value);
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(pageHTML(current!.bundle.file, current!.filter, timing));
  });
  server.get(BUNDLE_ROUTE, (_request, response) => {
    for (const [name, value] of Object.entries(DEFAULT_HTTP_HEADERS))
      response.setHeader(name, value);
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    response.end(current!.bundle.code);
  });
  server.get('/favicon.ico', (_request, response) => {
    response.statusCode = 204;
    response.end();
  });

  const browser = await Browser.launch({ browser: browserName });
  const config = { port: settings.port ?? 1234, portExplicit: settings.port !== undefined };
  await bindServerToPort(server, config);
  const origin = `http://localhost:${config.port}/`;
  const runtime = `${runtimeName(browserName)}/${browser.version()} ${process.arch}-${process.platform}`;
  const cpu = os.cpus()[0]?.model?.trim() || 'unknown';

  // One file, measured in a page of its own: a fresh heap and JIT, nothing left by the last file.
  const measure = async (built: Bundle, filter: string | undefined) => {
    current = { bundle: built, filter };
    return await measureFile(browser, origin, built, {
      ...settings,
      browser: browserName,
      filter,
      projectRoot,
      out,
      timing,
    });
  };

  const once = async (): Promise<BenchResult> => {
    const benches: BenchEntry[] = [];
    let failed = broken.length > 0;
    let onlyUsed = false;
    if (format === 'pretty') out.log(Report.header({ version: 1, runtime, cpu, benches }));
    const comparisons: Compare.Comparison[] = [];
    for (const built of bundles) {
      if (built.error) continue;
      let measured = await measure(built, settings.filter);
      if (measured.error) {
        failed = true;
        out.error(`${red('error')}: ${shown(built.file, cwd)}\n${measured.error}\n`);
        continue;
      }
      let fileReport: Report.BenchReport = { version: 1, runtime, cpu, benches: measured.benches };
      let comparison = baseline
        ? Compare.compare(fileReport, baseline, ruleOf(settings), projectRoot)
        : null;
      // A regression is measured again before it counts, keeping each bench's best: the least
      // disturbed measurement of the same code.
      for (
        let attempt = 0;
        comparison?.regressions.length && attempt < (settings.retries ?? 2);
        attempt++
      ) {
        const names = comparison.regressions.map((change) => change.bench.name);
        const again = await measure(built, Compare.exactly(names));
        fileReport = Compare.fastestOf(fileReport, again.benches);
        comparison = Compare.compare(fileReport, baseline!, ruleOf(settings), projectRoot);
      }
      if (comparison) comparisons.push(comparison);
      onlyUsed ||= measured.onlyUsed;
      measured = { ...measured, benches: fileReport.benches };
      benches.push(...measured.benches);
      failed ||= measured.benches.some((bench) => 'failed' in bench.results[0]);
      if (format === 'pretty') {
        out.log(Report.pretty({ origin: built.origin, benches: measured.benches }, comparison));
        for (const bench of measured.benches) {
          const result = bench.results[0];
          if (
            'ok' in result &&
            !result.ok.usedExplicitTimers &&
            result.ok.avg < 10_000 &&
            result.ok.min === 0
          ) {
            out.error(
              `${yellow(`Warning: "${bench.name}" times each of its n iterations alone, finer than this browser's clock:\nleave n out to have it timed in batches.`)}\n`,
            );
          }
          if ('ok' in result && result.ok.usedExplicitTimers && result.ok.avg < 10_000) {
            out.error(
              `${yellow(`Warning: start() and end() calls in "${bench.name}" are ignored because it averages less\nthan 10µs per iteration. Remove them for better results.`)}\n`,
            );
          }
        }
      }
    }
    const report: Report.BenchReport = { version: 1, runtime, cpu, benches };
    const comparison = baseline
      ? mergeComparisons(comparisons, report, baseline, settings, projectRoot)
      : null;
    if (format !== 'pretty') out.log(Report.render(report, format, comparison));
    if (comparison) out.error(verdict(comparison, settings, cwd));
    if (onlyUsed) out.error(`${red('error')}: Bench failed because the "only" option was used\n`);
    else if (failed) out.error(`${red('error')}: Bench failed\n`);
    if (settings.save) {
      const target = path.resolve(cwd, settings.save);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
    }
    const exitCode = failed || onlyUsed || Boolean(comparison?.regressions.length) ? 1 : 0;
    return { ok: exitCode === 0, exitCode, report, comparison, files };
  };

  try {
    if (!settings.watch) return await once();
    const directories = await realWatchDirectories(
      bundles.flatMap((built) => built.watchDirectories),
    );
    return await watchLoop([...new Set(directories)], async () => {
      bundles = await Promise.all(files.map(build));
      await once();
      out.error(
        `# ${blue('Watching')} ${files.length} bench file${files.length === 1 ? '' : 's'}\n`,
      );
    });
  } finally {
    const pending = await closeCompletely({
      server: server.close(),
      browser: browser.close(),
      prelaunch: shutdownPrelaunch(),
    });
    if (pending.length) out.error(`# qunitx: ${pending.join(', ')} never finished closing\n`);
  }
}

/** One bench file, bundled: its code and source map, or why it would not build. */
interface Bundle {
  file: string;
  origin: string;
  code: string;
  decoder: SourceMapDecoder | null;
  watchDirectories: string[];
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
      target:
        options.browser === 'firefox'
          ? ['firefox115']
          : options.browser === 'webkit'
            ? ['safari16']
            : ['chrome120'],
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
  },
): Promise<{ benches: BenchEntry[]; onlyUsed: boolean; error: string | null }> {
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
  try {
    const cdp = settings.cpuThrottle || settings.profile ? await context.newCDPSession(page) : null;
    if (cdp && settings.cpuThrottle && settings.cpuThrottle > 1) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: settings.cpuThrottle });
    }
    if (cdp && settings.profile) {
      const directory = path.resolve(settings.cwd ?? process.cwd(), settings.profile);
      fs.mkdirSync(directory, { recursive: true });
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
      await page.exposeFunction('__qunitxBenchStarted', () => cdp.send('Profiler.start'));
      await page.exposeFunction('__qunitxBenchFinished', async (entry: BenchEntry) => {
        const { profile } = await cdp.send('Profiler.stop');
        const name = `${path.basename(built.file).replace(/\.[^.]+$/, '')}--${entry.name.replace(/[^\w.-]+/g, '-')}.cpuprofile`;
        fs.writeFileSync(path.join(directory, name), JSON.stringify(profile));
      });
    }
    await page.goto(url, { waitUntil: 'commit', timeout: NAVIGATION_TIMEOUT_MS });
    const handle = await page.waitForFunction(
      () => (globalThis as { __qunitxBenchDone?: unknown }).__qunitxBenchDone ?? null,
      null,
      { timeout: settings.timeout ?? 0, polling: 100 },
    );
    const done = (await handle.jsonValue()) as
      { ok: true; benches: BenchEntry[]; onlyUsed: boolean } | { ok: false; stack: string };
    if (!done.ok) return { benches: [], onlyUsed: false, error: mapped(done.stack) };
    if (uncaught.length)
      return { benches: done.benches, onlyUsed: done.onlyUsed, error: uncaught.join('\n') };
    // Stacks point at the file the bench was written in, not at the bundle.
    const benches = done.benches.map((bench) => {
      const result = bench.results[0];
      return 'failed' in result
        ? {
            ...bench,
            results: [{ failed: { ...result.failed, stack: mapped(result.failed.stack) } }],
          }
        : bench;
    });
    return { benches, onlyUsed: done.onlyUsed, error: null };
  } finally {
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

// One comparison of the whole run from each file's, so the verdict covers every file.
function mergeComparisons(
  comparisons: Compare.Comparison[],
  report: Report.BenchReport,
  baseline: Compare.BaselineEntry[],
  settings: BenchSettings,
  projectRoot: string,
): Compare.Comparison {
  const changes = comparisons.flatMap((comparison) => comparison.changes);
  return {
    ...Compare.compare(report, baseline, ruleOf(settings), projectRoot),
    changes,
    regressions: changes.filter((change) => change.regressed),
  };
}

function verdict(comparison: Compare.Comparison, settings: BenchSettings, cwd: string): string {
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
  void cwd;
  return `${red(`# ${comparison.regressions.length} regression${comparison.regressions.length === 1 ? '' : 's'}`)}${against}:\n${lines.join('\n')}\n${missing}`;
}

function ruleOf(settings: BenchSettings): Compare.RegressionRule {
  return { threshold: settings.threshold ?? 10, minDelta: settings.minDelta ?? 1_000 };
}

function readBaselineFile(file: string, projectRoot: string): Compare.BaselineEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw InvalidBenchSetting({
      setting: 'compare',
      reason: `cannot read ${file}: ${(error as Error).message}`,
    });
  }
  try {
    return Compare.readBaseline(json, projectRoot);
  } catch (error) {
    throw InvalidBenchSetting({
      setting: 'compare',
      reason: `${file} is ${(error as Error).message}`,
    });
  }
}

function readManifest(projectRoot: string): { qunitx?: unknown } {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

function emptyReport(browser: string): Report.BenchReport {
  return {
    version: 1,
    runtime: runtimeName(browser),
    cpu: os.cpus()[0]?.model?.trim() || 'unknown',
    benches: [],
  };
}

function runtimeName(browser: string): string {
  return browser === 'firefox' ? 'Firefox' : browser === 'webkit' ? 'WebKit' : 'Chromium';
}

function fromText(setting: keyof BenchSettings, value: string): unknown {
  if (setting === 'minDelta') return nanoseconds(value);
  if (
    ['threshold', 'retries', 'warmup', 'time', 'cpuThrottle', 'port', 'timeout'].includes(setting)
  ) {
    const number = Number(value.replace(/%$/, ''));
    return value.trim() === '' || Number.isNaN(number) ? value : number;
  }
  return value;
}

// `500ns`, `2µs`, `2us`, `1ms`, `1s`, or a bare number of nanoseconds.
function nanoseconds(value: string): number | string {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ns|µs|us|ms|s)?\s*$/.exec(value);
  if (!match) return value;
  const scale = { ns: 1, µs: 1e3, us: 1e3, ms: 1e6, s: 1e9 }[match[2] ?? 'ns'] ?? 1;
  return Number(match[1]) * scale;
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
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
