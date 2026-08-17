import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { format } from 'node:util';
import esbuild from 'esbuild';
import * as Args from '../args/index.ts';
import * as Browser from '../setup/browser.ts';
import * as Failure from '../result/failure.ts';
import * as Result from '../result/index.ts';
import * as SourceMap from '../utils/source-map.ts';
import { HTTPServer } from '../web/index.ts';
import { Task } from '../task/index.ts';
import { bindServerToPort } from '../setup/bind-server-to-port.ts';
import { blue, red } from '../utils/color.ts';
import { closeWithGrace } from '../utils/close-with-grace.ts';
import { findProjectRoot } from '../utils/find-project-root.ts';
import { pathExists } from '../utils/path-exists.ts';
import { qunitxRuntimePlugin } from '../setup/qunitx-runtime-plugin.ts';
import { shutdownPrelaunch } from '../chrome/prelaunch.ts';
import { processConsole, type Console } from '../console.ts';
import { MAX_BROWSER_LOGS } from '../api/reporter.ts';
import type { BrowserLog } from '../reporters/types.ts';
import type { ConsoleMessage, Page } from 'playwright-core';
import type { ProjectRootNotFoundFailure } from '../utils/find-project-root.ts';
import type { SourceMapDecoder } from '../utils/source-map.ts';

/** The path the bundle is served from. `SourceMap.isBundleUrl` knows this name. */
const BUNDLE_ROUTE = '/script.js';
// The wrapper imports the entry by this sentinel and {@link entryPlugin} resolves it, so no
// path arithmetic stands between the user's file and esbuild. Not a valid bare specifier, so
// it can never collide with a real package.
const ENTRY_SPECIFIER = 'qunitx:script-entry';
// Bounded because it covers Chrome reaching a localhost server we just bound, not the script's
// own work: a page that cannot commit a navigation in 30s is broken, not slow. Script EXECUTION
// is unbounded unless --timeout says otherwise — see ScriptConfig.timeout.
const NAVIGATION_TIMEOUT_MS = 30_000;
// Watch-mode debounce: one editor save is several fs events, and rebuilding on each would run the
// script against a half-written file.
const WATCH_DEBOUNCE_MS = 75;

/**
 * `qunitx run` was given no script file, or more than one.
 *
 * ```ts
 * import { ScriptTargetRequired } from './run.ts';
 *
 * ScriptTargetRequired({ count: 0 }).data.count; // 0
 * ScriptTargetRequired({ count: 2 }).message.startsWith('qunitx run needs'); // true
 * ```
 */
export const ScriptTargetRequired: Failure.FailureFactory<
  'ScriptTargetRequired',
  { count: number }
> = Failure.define(
  'ScriptTargetRequired',
  (data: { count: number }) =>
    `qunitx run needs exactly one script file (got ${data.count}). Usage: qunitx run script.ts`,
);

/**
 * `qunitx run` was pointed at a file that is not there.
 *
 * Checked here rather than left to esbuild: the entry is reached through a generated
 * `import(...)`, and esbuild treats an unresolvable DYNAMIC import as a warning, leaving it in
 * the bundle as a runtime fetch. The browser then 404s and reports "failed to load dynamically
 * imported module", which names the bundler's URL instead of the user's typo.
 *
 * ```ts
 * import { ScriptNotFound } from './run.ts';
 *
 * ScriptNotFound({ entry: '/proj/seed.ts' }).message; // 'no such script: /proj/seed.ts'
 * ```
 */
export const ScriptNotFound: Failure.FailureFactory<'ScriptNotFound', { entry: string }> =
  Failure.define('ScriptNotFound', (data: { entry: string }) => `no such script: ${data.entry}`);

/**
 * The script could not be bundled — a syntax error, or an import that does not resolve.
 *
 * ```ts
 * import { ScriptBuildFailed } from './run.ts';
 *
 * ScriptBuildFailed({ entry: '/proj/seed.ts' }).message; // 'could not build /proj/seed.ts'
 * ```
 */
export const ScriptBuildFailed: Failure.FailureFactory<'ScriptBuildFailed', { entry: string }> =
  Failure.define('ScriptBuildFailed', (data: { entry: string }) => `could not build ${data.entry}`);

/** Every way {@link setup} can reject its input. */
export type ScriptConfigFailure =
  | Failure.Of<typeof ScriptTargetRequired>
  | Failure.Of<typeof ScriptNotFound>
  | ProjectRootNotFoundFailure
  | Args.ParseFailure;

/**
 * Everything one `qunitx run` invocation needs. Its own type rather than the test runner's
 * `Config`: a script has no test files, no filter, no reporter and no output directory, and
 * threading a script mode through those would make every one of them mean two things.
 *
 * ```ts
 * import { silentConsole } from '../console.ts';
 *
 * const config: ScriptConfig = {
 *   entry: '/proj/seed.ts',
 *   projectRoot: '/proj',
 *   cwd: '/proj',
 *   browser: 'chromium',
 *   port: 1234,
 *   portExplicit: false,
 *   watch: false,
 *   open: false,
 *   timeout: null,
 *   console: silentConsole,
 * };
 * config.timeout; // null — unbounded, like `deno run`
 * ```
 */
export interface ScriptConfig {
  /** Absolute path of the script to run. */
  entry: string;
  /** Directory holding the nearest `package.json`; mapped stack frames print relative to it. */
  projectRoot: string;
  /** Directory relative imports and `node_modules` lookups resolve from. */
  cwd: string;
  /** Engine the script runs in. */
  browser: 'chromium' | 'firefox' | 'webkit';
  /** Port the local server binds. Updated in place to the port actually bound. */
  port: number;
  /** True when `--port` was given, which makes a taken port an error instead of a search. */
  portExplicit: boolean;
  /** `--watch`: re-run on every save instead of exiting after one run. */
  watch: boolean;
  /** `--open`: run in a visible browser window. */
  open: boolean;
  /** `--timeout`: ms the script may run before it is declared hung, or null for unbounded. */
  timeout: number | null;
  /** Where the script's own output goes. `processConsole` for the CLI. */
  console: Console;
}

/** What one execution of the script produced. */
export interface ScriptOutcome {
  /** `globalThis.exitCode` if the script set one, 1 if it threw, else 0. */
  exitCode: number;
  /**
   * The script's own console calls and uncaught errors, in emit order and capped at
   * {@link MAX_BROWSER_LOGS} — the same shape and the same cap a test run reports, because it is
   * the same thing: a page's console, read over CDP.
   */
  browserLogs: BrowserLog[];
  /** How many were dropped to stay under the cap. `0` when nothing was. */
  browserLogsDropped: number;
}

/**
 * Builds a {@link ScriptConfig} from `qunitx run`'s argv.
 *
 * ```ts
 * import * as Script from './run.ts';
 * import * as Failure from '../result/failure.ts';
 *
 * // Defined, not invoked: reads package.json off the real filesystem.
 * async function configure() {
 *   const config = await Script.setup(['seed.ts', '--browser=firefox']).result();
 *   return Failure.is(config) ? null : config.browser; // 'firefox'
 * }
 * ```
 */
export function setup(
  argv: string[] = process.argv.slice(3),
  cwd: string = process.cwd(),
): Task<ScriptConfig, ScriptConfigFailure> {
  return Task(async () => {
    const projectRoot = await findProjectRoot(cwd);
    // The test runner's parser, so `--browser`, `--port`, `--watch`, `--open` and `--timeout` mean
    // exactly what they mean everywhere else and a bad value is rejected with the same message.
    // Sync, so it hands back a union — `unwrap` throws the failure by identity into this Task.
    const flags = Result.unwrap(Args.parse(projectRoot, argv, cwd));

    // `.html` positionals are peeled into htmlPaths by the shared parser; for `run` an HTML file
    // is just as much "the one target" as a .ts file, so both lists count toward the arity check.
    const targets = flags.inputs.concat(flags.htmlPaths ?? []);
    if (targets.length !== 1) throw ScriptTargetRequired({ count: targets.length });

    return await configFor(targets[0], {
      cwd,
      projectRoot,
      browser: flags.browser,
      port: flags.port,
      portExplicit: flags.portExplicit,
      watch: flags.watch,
      open: flags.open === true,
      timeout: flags.timeout,
    });
  });
}

/** Everything a caller may set on a script run: the CLI's flags and the API's options, minus argv. */
export interface ScriptSettings {
  /** Directory the entry, relative imports and `node_modules` lookups resolve against. */
  cwd?: string;
  /** Skips the `package.json` walk when the caller has already done it. */
  projectRoot?: string;
  /** Engine the script runs in. Defaults to chromium. */
  browser?: 'chromium' | 'firefox' | 'webkit';
  /** Port the local server binds. Defaults to 1234. */
  port?: number;
  /** True when a port was named explicitly, which makes a taken one an error rather than a search. */
  portExplicit?: boolean;
  /** Re-run on every save instead of exiting after one run. */
  watch?: boolean;
  /** Run in a visible browser window. */
  open?: boolean;
  /** Ms the script may run before it is declared hung; null (the default) is unbounded. */
  timeout?: number | null;
  /**
   * Where the script's own output goes, as `test()` and `watch()` take one. Defaults to this
   * process's stdout and stderr; pass `silentConsole` to capture it from the result instead.
   */
  console?: Console;
}

/** The two ways naming an entry can fail, before any flag or option is even looked at. */
export type ScriptEntryFailure = Failure.Of<typeof ScriptNotFound> | ProjectRootNotFoundFailure;

/**
 * Builds a {@link ScriptConfig} for one entry — the half of {@link setup} that is not about argv.
 *
 * Shared rather than duplicated because it is the VALIDATION: the project-root walk, the existence
 * check, and every default. A second copy for the programmatic path is exactly the kind that
 * drifts, and the two would then disagree about what `qunitx run x.ts` and `run('x.ts')` accept.
 *
 * ```ts
 * import * as RunCommand from './run.ts';
 * import * as Failure from '../result/failure.ts';
 *
 * // Defined, not invoked: walks for package.json and stats the entry.
 * async function configure() {
 *   const config = await RunCommand.configFor('seed.ts', { browser: 'firefox' }).result();
 *   return Failure.is(config) ? null : config.browser; // 'firefox'
 * }
 * ```
 */
export function configFor(
  entry: string,
  settings: ScriptSettings = {},
): Task<ScriptConfig, ScriptEntryFailure> {
  return Task(async () => {
    const cwd = settings.cwd ?? process.cwd();
    const projectRoot = settings.projectRoot ?? (await findProjectRoot(cwd));
    // Resolved here so a programmatic `run('seed.ts')` means the same file as the CLI's, which
    // gets its absolute path from Args.parse. Already-absolute paths pass through untouched.
    const absoluteEntry = path.resolve(cwd, entry);
    if (!(await pathExists(absoluteEntry))) throw ScriptNotFound({ entry: absoluteEntry });

    return {
      entry: absoluteEntry,
      projectRoot,
      cwd,
      browser: settings.browser ?? 'chromium',
      port: settings.port ?? 1234,
      portExplicit: settings.portExplicit ?? false,
      watch: settings.watch ?? false,
      open: settings.open ?? false,
      timeout: settings.timeout ?? null,
      console: settings.console ?? processConsole,
    };
  });
}

/**
 * Runs a script file in a real browser: bundles it with esbuild, serves it from a localhost
 * origin, evaluates it as a module in the page, and streams its `console` output to this
 * terminal. Resolves once the script's top level — including any top-level `await` — settles.
 *
 * The browser is the whole point. Running the file in Node would be `node`, which qunitx adds
 * nothing to; running it in Chrome gives it a DOM, `fetch` against a real origin, and the same
 * TypeScript/JSX bundling the test runner uses.
 *
 * ```ts
 * import * as Script from './run.ts';
 *
 * import type { ScriptConfig } from './run.ts';
 *
 * // Defined, not invoked: launches a real browser and binds a real port.
 * async function seed(config: ScriptConfig) {
 *   const outcome = await Script.run(config);
 *   return outcome.exitCode; // 0, or whatever the script assigned to globalThis.exitCode
 * }
 * ```
 */
export async function run(config: ScriptConfig): Promise<ScriptOutcome> {
  const server = new HTTPServer();
  let bundle = await build(config);

  server.get('/', (_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(pageHTML());
  });
  server.get(BUNDLE_ROUTE, (_request, response) => {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(bundle.code);
  });
  // Answered rather than 404'd: a script's stderr is its output, and the browser's own
  // "failed to load resource" complaint about a favicon qunitx never asked for is not the
  // script's. 204 is the cheapest way to make the browser stop asking.
  server.get('/favicon.ico', (_request, response) => {
    response.statusCode = 204;
    response.end();
  });

  const browser = await Browser.launch(config);
  const [page] = await Promise.all([browser.newPage(), bindServerToPort(server, config)]);
  const url = `http://localhost:${config.port}/`;

  if (!config.watch) {
    try {
      return await execute(page, url, config, () => bundle.decoder);
    } finally {
      // Bounded, never sequential awaits: once the server, browser and Chrome are gone no handle
      // holds the loop open, so a close that never settles drains it and the process exits 0 with
      // the real exit code computed and never committed. closeWithGrace's timer is itself a live
      // handle, so the loop cannot drain out from under the exit code.
      await closeWithGrace([server.close(), browser.close(), shutdownPrelaunch()]);
    }
  }

  // The watcher goes up BEFORE the first run, and the first run goes THROUGH it. Both halves
  // matter: a save landing during that first run used to be dropped, and once it was not, it
  // started a second execute() against the same page while the first was still navigating.
  // Never resolves: watch mode ends when the process is signalled.
  let first = true;
  const watched = await realWatchDirectories(bundle.watchDirectories);

  return await watchLoop(watched, async () => {
    if (!first) bundle = await build(config);
    await execute(page, url, config, () => bundle.decoder);
    if (!first) return;
    first = false;
    console.log('#', blue(`Watching ${path.relative(config.projectRoot, config.entry)} on ${url}`));
  });
}

/** One build of the script: the bundle text, its source map, and what watch mode should watch. */
interface ScriptBundle {
  code: string;
  decoder: SourceMapDecoder | null;
  /** Directories holding the first-party files that went into the bundle. */
  watchDirectories: string[];
}

/**
 * Bundles the entry behind a `try` / `await import(...)` wrapper.
 *
 * The wrapper is what makes the mode work at all. esbuild lowers a dynamically imported
 * top-level-await module into an async initialiser, so `await` at the script's top level is legal
 * — a bare `iife` bundle rejects it outright — AND a rejection there is caught rather than
 * escaping as an unhandled rejection with no stack the page can hand back.
 */
async function build(config: ScriptConfig): Promise<ScriptBundle> {
  const result = await esbuild
    .build({
      stdin: { contents: wrapperSource(), resolveDir: config.cwd },
      nodePaths: ancestorNodeModules(config.cwd),
      // Pinned, not defaulted: metafile input paths are relative to it, and leaving it implicit
      // made them relative to process.cwd() while they were being resolved against projectRoot —
      // the same directory only until someone runs a script from outside their project.
      absWorkingDir: config.cwd,
      bundle: true,
      write: false,
      metafile: true,
      logLevel: 'silent',
      // esm, not iife: `<script type="module">` is what gives the script a real `import.meta.url`
      // and lets esbuild keep the awaits rather than rejecting the build.
      format: 'esm',
      outdir: config.projectRoot,
      keepNames: true,
      legalComments: 'none',
      target: esbuildTarget(config.browser),
      sourcemap: 'inline',
      jsx: 'automatic',
      plugins: [entryPlugin(config.entry), qunitxRuntimePlugin(config.cwd)],
    })
    .catch((cause: unknown) => {
      throw ScriptBuildFailed({ entry: config.entry }, { cause });
    });

  const code = result.outputFiles[0].text;

  return {
    code,
    decoder: SourceMap.extractInline(code, config.projectRoot),
    watchDirectories: watchDirectoriesFrom(Object.keys(result.metafile.inputs), config.cwd),
  };
}

/**
 * The directories watch mode should watch, from esbuild's metafile input keys.
 *
 * esbuild reports inputs relative to `absWorkingDir` when it can and ABSOLUTELY when it cannot —
 * a script on another Windows drive than the project has no relative form. `resolve` handles both
 * because an absolute second argument wins outright; the earlier code only ever saw the relative
 * case. `node_modules` is dropped (a dependency edit is not a script edit) along with esbuild's
 * synthetic `<stdin>` entry, which is not a file at all.
 *
 * `pathApi` is injected so the Windows shape is provable from a POSIX host.
 *
 * ```ts
 * import path from 'node:path';
 * import { watchDirectoriesFrom } from './run.ts';
 *
 * watchDirectoriesFrom(['<stdin>', 'scripts/seed.ts'], '/proj', path.posix); // ['/proj/scripts']
 * ```
 */
export function watchDirectoriesFrom(
  inputs: string[],
  cwd: string,
  pathApi: Pick<typeof path, 'resolve' | 'dirname'> = path,
): string[] {
  const directories = inputs
    .filter((input) => !input.includes('node_modules') && !input.startsWith('<'))
    .map((input) => pathApi.dirname(pathApi.resolve(cwd, input)));

  return [...new Set(directories)];
}

/**
 * Expands each directory to its real path before anything watches it.
 *
 * Windows 8.3 short names are why. A script under `C:\Users\RUNNER~1\…` registers the watch on
 * the short spelling, while ReadDirectoryChangesW reports its events under the expanded long one.
 * libuv prefix-compares the two and, when they disagree, ABORTS the process outright
 * (`uv_fs_event`, src/win/fs-event.c) — so the CLI dies mid-watch having printed nothing, which
 * is indistinguishable from a hang. Nothing else in the chain normalises the path: esbuild's
 * metafile echoes back whatever {@link entryPlugin} was handed, which is the spelling the user
 * typed. Same reason the test runner's own watcher realpaths what it walks.
 *
 * A directory that will not resolve is kept as given — watching the path as typed beats not
 * watching it at all.
 *
 * ```ts
 * import { realWatchDirectories } from './run.ts';
 *
 * await realWatchDirectories(['/a', '/b'], (directory) => Promise.resolve(`${directory}-real`));
 * // ['/a-real', '/b-real']
 * ```
 */
export async function realWatchDirectories(
  directories: string[],
  realpath: (directory: string) => Promise<string> = (directory) => fs.promises.realpath(directory),
): Promise<string[]> {
  const resolved = await Promise.all(
    directories.map((directory) => realpath(directory).catch(() => directory)),
  );

  return [...new Set(resolved)];
}

/**
 * Hands esbuild the entry's absolute path for {@link ENTRY_SPECIFIER}.
 *
 * The wrapper used to import the entry by a relative specifier computed with `path.relative`,
 * which has no answer across Windows drive letters: with the project on `D:` and the script under
 * `C:\…\Temp`, it returns the absolute target, and prefixing `./` to that produced `./C:/…`.
 * esbuild cannot resolve that, and an unresolvable DYNAMIC import is only a warning — so the
 * build "succeeded" and the page 404'd instead of the syntax error being reported.
 */
function entryPlugin(entry: string): esbuild.Plugin {
  return {
    name: 'qunitx-script-entry',
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${ENTRY_SPECIFIER}$`) }, () => ({ path: entry }));
    },
  };
}

/** The entry esbuild actually compiles. `globalThis.exitCode` is the script's `process.exitCode`. */
function wrapperSource(): string {
  return `globalThis.__qunitxScript = { done: null };
(async () => {
  try {
    await import(${JSON.stringify(ENTRY_SPECIFIER)});
    globalThis.__qunitxScript.done = {
      ok: true,
      exitCode: Number.isInteger(globalThis.exitCode) ? globalThis.exitCode : 0,
    };
  } catch (error) {
    globalThis.__qunitxScript.done = { ok: false, stack: String((error && error.stack) || error) };
  }
})();
`;
}

function pageHTML(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>qunitx run</title></head>
<body><script type="module" src="${BUNDLE_ROUTE}"></script></body>
</html>
`;
}

/** What the page reports back once the script's top level has settled. */
interface DoneSignal {
  ok: boolean;
  exitCode?: number;
  stack?: string;
}

/** The one property {@link wrapperSource} adds to the page's global object. */
type ScriptGlobal = { __qunitxScript?: { done: DoneSignal | null } };

/**
 * Navigates, streams the page's console to this terminal, and waits for the script to settle.
 *
 * `decoderOf` is a getter rather than the decoder itself because watch mode rebuilds between
 * executions: the handlers installed here must map frames through the map of whichever bundle is
 * currently loaded, not the one they closed over on the first run.
 */
async function execute(
  page: Page,
  url: string,
  config: ScriptConfig,
  decoderOf: () => SourceMapDecoder | null,
): Promise<ScriptOutcome> {
  // Capped the way a test run caps its own: a script that logs in a loop must not grow this array
  // until the process dies, and dropping from the FRONT keeps the lines next to whatever went
  // wrong. `browserLogsDropped` is what stops that being a silent truncation.
  const browserLogs: BrowserLog[] = [];
  let browserLogsDropped = 0;
  const record = (log: BrowserLog) => {
    browserLogs.push(log);
    if (browserLogs.length > MAX_BROWSER_LOGS) {
      browserLogs.shift();
      browserLogsDropped++;
    }
  };

  // Console arguments are fetched the moment the event fires, so the round-trips overlap, but
  // WRITTEN through a chain, so the terminal's line order is the page's emit order. Fetching
  // inside the chain would serialise every round-trip; writing outside it would let a message
  // carrying a big object land after one emitted later.
  let writes: Promise<void> = Promise.resolve();
  const onConsole = (message: ConsoleMessage) => {
    const rendered = renderConsoleMessage(message);
    const type = message.type();
    const write = isErrorLevel(type) ? config.console.error : config.console.log;
    writes = writes.then(async () => {
      const text = mapStack(await rendered, decoderOf(), config.projectRoot);
      // Recorded on the same chain that writes it, so `browserLogs` ends up in the page's emit
      // order rather than in whatever order the argument round-trips happened to resolve.
      record({ type, text, args: [] });
      // The newline belongs to the caller with this Console shape — `streamConsole` writes what it
      // is given, verbatim. Without it a script's output runs into whatever is printed next.
      write(`${text}\n`);
    });
  };
  const uncaught: string[] = [];
  const onPageError = (error: Error) => {
    uncaught.push(error.stack ?? String(error));
    record({ type: 'pageerror', text: error.stack ?? String(error), args: [] });
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  try {
    // reload rather than goto when the URL already matches: watch mode re-runs the same page, and
    // Playwright treats a goto to the current URL as a no-op navigation.
    const navigation = { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: 'commit' as const };
    await (page.url() === url ? page.reload(navigation) : page.goto(url, navigation));

    const handle = await page.waitForFunction(
      () => (globalThis as ScriptGlobal).__qunitxScript?.done ?? null,
      null,
      // Playwright reads 0 as "no timeout", which is what an absent --timeout means here.
      { timeout: config.timeout ?? 0 },
    );
    const done = (await handle.jsonValue()) as DoneSignal;

    // Drain before deciding anything. A `console.log` on the script's last line and the done
    // signal travel the same CDP channel, so the log event is already queued — but its argument
    // round-trip is not, and returning here would cut it off mid-flight.
    await page.evaluate(() => 0).catch(() => {});
    await writes;

    if (!done.ok) {
      config.console.error(`${red(mapStack(done.stack ?? '', decoderOf(), config.projectRoot))}\n`);
      return { exitCode: 1, browserLogs, browserLogsDropped };
    }
    uncaught.forEach((stack) =>
      config.console.error(`${red(mapStack(stack, decoderOf(), config.projectRoot))}\n`),
    );

    return {
      exitCode: uncaught.length > 0 ? 1 : (done.exitCode ?? 0),
      browserLogs,
      browserLogsDropped,
    };
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
  }
}

/**
 * `console.log`'s own renderer, so the terminal line is byte-identical to what the page printed.
 *
 * A message with NO args is not an empty message: browser-generated entries (a failed resource
 * load, a CSP violation) carry their text and nothing else, and rendering their empty arg list
 * printed a blank line where the reason should have been.
 */
async function renderConsoleMessage(message: ConsoleMessage): Promise<string> {
  const args = await Promise.all(message.args().map((arg) => arg.jsonValue())).catch(() => null);

  return args?.length ? format(...args) : message.text();
}

function isErrorLevel(type: string): boolean {
  return type === 'error' || type === 'warning' || type === 'assert';
}

/**
 * Rewrites `script.js:LINE:COL` frames back to source and drops qunitx's own. Applied to every
 * line the script prints, not just thrown stacks: `console.error(error)` renders a stack too, and
 * a trace pointing into a generated bundle is the one thing that makes a browser runner feel
 * unlike a local one. Lines that are not stack frames are returned untouched.
 */
function mapStack(text: string, decoder: SourceMapDecoder | null, projectRoot: string): string {
  const mapped = decoder ? SourceMap.resolveStack(text, decoder, projectRoot).resolvedStack : text;

  return mapped
    .split('\n')
    .filter((line) => !isInternalFrame(line))
    .join('\n');
}

/**
 * True for a frame inside {@link wrapperSource} or esbuild's module scaffolding. These sit below
 * every frame the user wrote, on every trace, and say nothing about their code — the same reason
 * Node hides its own `node:internal/` frames. A frame that resolved back to source is always
 * kept, so a user file named `stdin.ts` cannot be swallowed by this.
 */
function isInternalFrame(line: string): boolean {
  return /^\s+at\s.*(?:<stdin>|\/script\.js):\d+:\d+\)?\s*$/.test(line);
}

/**
 * Runs `run` once, then again on every change to a first-party file in the bundle. Never resolves
 * — watch mode ends when the process is signalled — except to REJECT if the very first run
 * throws, which is a script that never started rather than a bad edit to recover from.
 *
 * Runs are serialised, and the FIRST run is serialised with them. It is the slowest of the
 * session (bundle, browser launch, navigate), so it is the likeliest one to receive a save; left
 * outside the guard, that save began a second run against the same page while the first was still
 * navigating, and the two wedged each other until the watch timed out. A change arriving mid-run
 * is remembered rather than dropped — the run in flight is already executing stale code.
 *
 * Watches DIRECTORIES rather than the files themselves: editors save by writing a temp file and
 * renaming it over the original, which severs a per-file watch on the very first save.
 *
 * `watch` is injected so the serialisation is testable without a filesystem.
 *
 * ```ts
 * import { watchLoop } from './run.ts';
 *
 * // Defined, not invoked: the returned promise settles only on a first-run failure.
 * function example() {
 *   return watchLoop([], () => Promise.resolve(), () => {});
 * }
 * ```
 */
export function watchLoop(
  directories: string[],
  run: () => Promise<void>,
  watch: (directory: string, listener: () => void) => void = (directory, listener) =>
    void fs.watch(directory, listener),
  debounceMs: number = WATCH_DEBOUNCE_MS,
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    let pending = false;
    let first = true;

    const trigger = async (): Promise<void> => {
      if (running) return void (pending = true);
      running = true;
      const failure = await run().then(
        () => null,
        (error: unknown) => error,
      );
      running = false;
      if (failure && first) return reject(failure);
      if (failure) process.stderr.write(`${red(String(failure))}\n`);
      first = false;
      if (pending) {
        pending = false;
        await trigger();
      }
    };
    const rerun = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void trigger(), debounceMs);
    };

    directories.forEach((directory) => watch(directory, rerun));
    void trigger();
  });
}

/**
 * All `node_modules` directories on `dir`'s ancestor chain, nearest first — esbuild's `nodePaths`,
 * so a script outside the project root can still import packages installed above it.
 */
function ancestorNodeModules(dir: string): string[] {
  return dir
    .split(path.sep)
    .map((_, index, parts) =>
      path.join(parts.slice(0, parts.length - index).join(path.sep) || path.sep, 'node_modules'),
    );
}

/** Matches the test runner's targets: only output syntax, never what the script may be written in. */
function esbuildTarget(browser: string): string[] {
  if (browser === 'firefox') return ['firefox115'];
  else if (browser === 'webkit') return ['safari16'];

  return ['chrome120'];
}
