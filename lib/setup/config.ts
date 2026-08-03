import fs from 'node:fs/promises';
import path, { matchesGlob } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { blue } from '../utils/color.ts';
import { defaultProjectConfigValues } from './default-project-config-values.ts';
import { findProjectRoot, type ProjectRootNotFoundFailure } from '../utils/find-project-root.ts';
import * as FSTree from './fs-tree.ts';
import * as TestFilePaths from './test-file-paths.ts';
import { getChangedFsTree } from './get-changed-fs-tree.ts';
import * as Args from '../args/index.ts';
import * as FailureCache from '../utils/failure-cache.ts';
import * as Reporter from '../reporters/index.ts';
import * as RunState from './run-state.ts';
import * as Result from '../result/index.ts';
import { Task } from '../task/index.ts';
import type { Config, FSTree as FSTreeShape } from '../types.ts';
import type { Plugin as EsbuildPlugin } from 'esbuild';

/**
 * `package.json#qunitx.plugins` was present but not an array.
 *
 * ```ts
 * import * as Config from './config.ts';
 *
 * const failure = Config.InvalidPlugins({ received: 'string' });
 * failure.message; // 'package.json#qunitx.plugins must be an array, received string'
 * ```
 */
export const InvalidPlugins = Result.Failure.define(
  'InvalidPlugins',
  (data: { received: string }) =>
    `package.json#qunitx.plugins must be an array, received ${data.received}`,
);

/**
 * A plugin specifier could not be resolved or imported.
 *
 * Previously this was an unhandled throw out of a `Promise.all`, so a typo'd plugin name
 * surfaced as a raw `ERR_MODULE_NOT_FOUND` stack with no indication that a *plugin* was at
 * fault or which entry named it.
 *
 * ```ts
 * import * as Config from './config.ts';
 *
 * const failure = Config.PluginLoadFailed({ specifier: 'esbuild-plugin-vue' }, { cause: new Error('ERR_MODULE_NOT_FOUND') });
 * failure.data.specifier; // 'esbuild-plugin-vue' — the entry at fault, resolver error under `.cause`
 * ```
 */
export const PluginLoadFailed = Result.Failure.define(
  'PluginLoadFailed',
  (data: { specifier: string }) => `could not load esbuild plugin "${data.specifier}"`,
);

/**
 * Every way config assembly can fail with something the user can act on.
 *
 * ```ts
 * import * as Config from './config.ts';
 *
 * const failure: Config.ConfigFailure = Config.InvalidPlugins({ received: 'number' });
 * failure.code; // 'InvalidPlugins' | 'PluginLoadFailed' | 'InvalidFlag' — switch and report
 * ```
 */
export type ConfigFailure =
  | Args.ParseFailure
  | ProjectRootNotFoundFailure
  | FSTree.InputUnreadableFailure
  | Result.Failure.Of<typeof InvalidPlugins | typeof PluginLoadFailed>;

/**
 * Resolved settings handed to {@link setup} in place of an argv, by the JS API and by anyone
 * else assembling a run programmatically. Every CLI flag has a field here — they are the same
 * settings, arrived at by a different route — plus the two things argv cannot express: a working
 * directory, and esbuild plugins as live objects rather than module specifiers.
 *
 * `inputs` are raw targets, exactly as they would be typed on the command line: relative or
 * absolute, `.html` fixtures, `file.ts#34` line targets. {@link Args.applyInputs} classifies them.
 *
 * ```ts
 * import * as Config from './config.ts';
 *
 * const options: Config.ConfigOptions = { inputs: ['test/cart-test.ts#34'], filter: 'Cart' };
 * options.inputs; // ['test/cart-test.ts#34'] — resolved against `cwd` by setup()
 * ```
 */
export interface ConfigOptions extends Partial<Args.ParsedFlags> {
  /** Directory the project root and relative inputs resolve against. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Live esbuild plugin objects, appended after any resolved from `package.json#qunitx.plugins`. */
  esbuildPlugins?: EsbuildPlugin[];
}

/**
 * Builds the merged qunitx config from package.json settings and either an argv or an explicit
 * {@link ConfigOptions}. `package.json#qunitx.plugins` entries are dynamic-imported into esbuild
 * plugin objects.
 *
 * `ConfigFailure` is *declared*, so `.result()` hands back the bare union to branch on with
 * `Failure.is`. It reports rather than exits so the daemon — which assembles a config per client
 * request — can reject one bad flag and stay up; `cli.ts` turns a failure into an exit.
 *
 * Lazy, like every Task: nothing is read until it is awaited. With no argument `setup` reads
 * `process.argv` and `process.env` at that moment, so a caller that lends those globals (the
 * daemon, via `borrowArgv`/`borrowEnv`) must await INSIDE the borrowing scope, not hold the Task
 * past it. Passing options instead skips the argv read entirely — which is why the JS API needs
 * no such borrowing.
 *
 * ```ts
 * import * as Config from './config.ts';
 * import * as Result from '../result/index.ts';
 *
 * // Defined, not invoked: reads package.json and walks the real fs.
 * async function example() {
 *   const config = await Config.setup({ inputs: ['test/'] }).result();
 *   return Result.Failure.is(config) ? config.code : config.inputs; // ConfigFailure, or the Config
 * }
 * ```
 */
export function setup(options?: ConfigOptions): Task<Config, ConfigFailure> {
  return Task(async () => {
    // Every declared failure below rejects rather than returning: the Task's E channel carries
    // them, so the guard-and-return-it ladder this function used to open with is gone. Args.parse
    // is synchronous, so it hands back a union rather than a Task — `unwrap` is the union's own
    // way into that channel, throwing the failure by identity so its stack still points at Args.
    const { cwd: requestedCwd, esbuildPlugins, ...provided } = options ?? {};
    const cwd = requestedCwd ? path.resolve(requestedCwd) : process.cwd();
    const projectRoot = await findProjectRoot(cwd);
    // Given options, the positional grammar still applies — `applyInputs` is the same
    // classification argv positionals go through, so `'a.ts#34'` targets a line either way.
    const flags = options
      ? Args.applyInputs({ ...provided, inputs: [] }, projectRoot, cwd, provided.inputs ?? [])
      : Result.unwrap(Args.parse(projectRoot, process.argv.slice(2), cwd));
    const projectPackageJSON = await readConfigFromPackageJSON(projectRoot);
    const { plugins: rawPlugins, ...userQunitx } =
      (projectPackageJSON.qunitx as Partial<Config> & {
        plugins?: unknown;
      }) ?? {};
    const inputs = flags.inputs.concat(readInputsFromPackageJSON(projectPackageJSON));
    const config = {
      ...defaultProjectConfigValues,
      htmlPaths: [] as string[],
      ...userQunitx,
      ...flags,
      projectRoot,
      cwd,
      inputs,
      testFileLookupPaths: TestFilePaths.setup(inputs),
      state: RunState.create(),
      // Asserted rather than inferred because fsTree and plugins are filled in by the awaits
      // below — the literal is deliberately partial, and the function's contract is that a
      // complete Config is only guaranteed at the return. The later `as Config` casts this
      // function used to repeat are now redundant.
    } as Config;
    // `--debug` also reveals `.ignore(context)`-suppressed rejections as TAP comments —
    // one flag lights every deliberate swallow. (QUNITX_DEBUG covers the env path at
    // failure.ts load; enable-only, so a daemon run without the flag never turns it off.)
    if (config.debug) Result.Failure.setDebug(true);
    config.htmlPaths = normalizeHTMLPaths(config.projectRoot, config.htmlPaths);
    // Started together, so plugin dynamic-imports overlap fsTree's I/O. The two used to be kicked
    // off on separate lines to get that overlap; they didn't need to be, because everything between
    // those lines was synchronous and no import could progress during it.
    const [fsTree, resolvedPlugins] = await Task.all([
      FSTree.build(config.testFileLookupPaths, config),
      resolvePlugins(rawPlugins, projectRoot),
    ]);
    config.fsTree = fsTree;
    // package.json specifiers first, then the caller's live objects — the same order the two
    // sources are declared in, so an API-supplied plugin can override an earlier one's handlers.
    config.plugins = esbuildPlugins ? resolvedPlugins.concat(esbuildPlugins) : resolvedPlugins;

    pruneSupersededLineTargets(config);

    // --changed / --since: filter fsTree to test files whose transitive deps
    // include a changed file. Watch mode skips this — watch is for fast feedback
    // on every save, not "what does my working tree affect" semantics.
    if (config.changedSince && !config.watch) {
      config.fsTree = await getChangedFsTree(
        config.fsTree,
        config.projectRoot,
        config.changedSince,
      );
    }

    // --only-failed: restrict the whole run to files that failed on the previous run (persistent
    // cache). Watch mode is handled separately in run.ts — there the full fsTree is preserved (so
    // `qa` and file-save reruns still see every file) and only the INITIAL run is scoped to the
    // failures. See applyOnlyFailedFilter for the no-targets vs. scoped-targets behavior.
    if (config.onlyFailed && !config.watch) {
      config.fsTree = await applyOnlyFailedFilter(config);
    }

    // Built last: reporter selection reads the fully-merged flags. One instance per run, shared
    // by every concurrent group via the group-config spread in run.ts.
    config.state.reporters = Reporter.create(config);

    return config;
  });
}

/**
 * Drops a `file#34` line target when another input already includes that file whole — a directory
 * or glob that covers it. A broad input is a "run everything under here" gesture, so letting a
 * coincidental line target silently shrink one of its files would run FEWER tests than the human
 * asked for. The broader input wins (the file runs whole); the superseded target is announced
 * rather than dropped silently. A file named only by its own `#line` keeps it — nothing else
 * covers it.
 */
function pruneSupersededLineTargets(config: Config): void {
  const lineTargets = config.lineTargets;
  if (!lineTargets) return;
  // Only whole-file mentions supersede — a directory, a glob, or the same path given bare
  // (`a.ts a.ts#34`). A path present ONLY as a line target is not in this list, so it keeps its
  // target.
  const wholeInputs = config.wholeInputPaths ?? [];

  for (const file of Object.keys(lineTargets)) {
    const coveredBy = wholeInputs.find((input) => coversFileWhole(input, file));
    if (!coveredBy) continue;
    const rel = path.relative(config.projectRoot, file).replaceAll('\\', '/');
    console.log(
      '#',
      blue(
        `qunitx: ${rel}#${lineTargets[file].join(',')} line target ignored — a broader input runs the whole file`,
      ),
    );
    delete lineTargets[file];
  }

  if (Object.keys(lineTargets).length === 0) delete config.lineTargets;
}

/** True when a whole-file input includes `file`: the same path, a directory above it, or a glob. */
function coversFileWhole(input: string, file: string): boolean {
  return (
    input === file ||
    file.startsWith(input.endsWith(path.sep) ? input : `${input}${path.sep}`) ||
    matchesGlob(file, input)
  );
}

async function readConfigFromPackageJSON(projectRoot: string) {
  const packageJSON = await fs.readFile(`${projectRoot}/package.json`);

  return JSON.parse(packageJSON.toString()) as { qunitx?: unknown; [key: string]: unknown };
}

function normalizeHTMLPaths(projectRoot: string, htmlPaths: string[]): string[] {
  return Array.from(new Set(htmlPaths.map((htmlPath) => `${projectRoot}/${htmlPath}`)));
}

/**
 * Builds the `--only-failed` fsTree from the persistent failure cache. With no input targets it
 * re-runs exactly the cached files; with targets it intersects the cache with the discovered
 * fsTree so failures are scoped to what the user asked for. Files that no longer exist (deleted
 * or renamed since the failing run) are dropped. A missing cache falls back to running everything.
 */
async function applyOnlyFailedFilter(config: Config): Promise<FSTreeShape> {
  const failed = await FailureCache.filesToRerun(
    config.projectRoot,
    config.inputs.length > 0,
    config.fsTree,
  );
  if (failed === null) {
    console.log('#', `qunitx --only-failed: no failure cache found — running all tests`);
    return config.fsTree;
  }

  const count = failed.length;
  console.log(
    '#',
    count === 0
      ? `qunitx --only-failed: no previously-failing test files to run`
      : `qunitx --only-failed: re-running ${count} previously-failing test file${count === 1 ? '' : 's'}`,
  );
  return Object.fromEntries(failed.map((file) => [file, config.fsTree[file] ?? null]));
}

function readInputsFromPackageJSON(packageJSON: {
  qunitx?: unknown;
  [key: string]: unknown;
}): string[] {
  const qunitx = packageJSON.qunitx as { inputs?: string[] } | undefined;

  return qunitx && qunitx.inputs ? qunitx.inputs : [];
}

/**
 * Dynamic-imports each `package.json#qunitx.plugins` entry from the user's project. An entry
 * is either a string specifier (`"esbuild-plugin-vue-next"`) or a `[specifier, options]` tuple.
 * Function exports are invoked as factories with the options; object exports are used directly.
 * `createRequire(projectRoot)` keeps resolution rooted at the user's project so plugins work
 * under local installs, globals, or `npx`.
 */
function resolvePlugins(
  raw: unknown,
  projectRoot: string,
): Task<EsbuildPlugin[], Result.Failure.Of<typeof InvalidPlugins | typeof PluginLoadFailed>> {
  return Task(() => {
    if (raw == null) return [];
    if (!Array.isArray(raw)) throw InvalidPlugins({ received: typeof raw });

    const projectRequire = createRequire(`${projectRoot}/package.json`);
    // One Task per entry, so the failure can name *which* specifier broke — a bare
    // `Promise.all` reports the first rejection with no such context.
    return Task.all(
      raw.map((entry) => {
        const [spec, options] = Array.isArray(entry) ? entry : [entry];
        return Task(async () => {
          const mod = await import(pathToFileURL(projectRequire.resolve(spec as string)).href);
          const exported = mod.default ?? mod;
          return (typeof exported === 'function' ? exported(options) : exported) as EsbuildPlugin;
        }).mapErr((cause) => {
          // Only a resolution/import error (a Node error carrying `code`, e.g.
          // ERR_MODULE_NOT_FOUND) is the declared "could not load" failure. A plugin factory
          // that throws while building its own options is a bug and stays one.
          if (!Result.isErrno(cause)) throw cause;
          return PluginLoadFailed({ specifier: String(spec) }, { cause });
        });
      }),
    );
  });
}
