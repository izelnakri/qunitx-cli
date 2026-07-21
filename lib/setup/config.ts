import fs from 'node:fs/promises';
import path, { matchesGlob } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { blue } from '../utils/color.ts';
import { defaultProjectConfigValues } from './default-project-config-values.ts';
import { findProjectRoot } from '../utils/find-project-root.ts';
import * as FSTree from './fs-tree.ts';
import * as TestFilePaths from './test-file-paths.ts';
import { getChangedFsTree } from './get-changed-fs-tree.ts';
import * as Args from '../args/index.ts';
import * as FailureCache from '../utils/failure-cache.ts';
import * as Reporter from '../reporters/index.ts';
import * as RunState from './run-state.ts';
import type { Config, FSTree as FSTreeShape } from '../types.ts';
import type { Plugin as EsbuildPlugin } from 'esbuild';

/**
 * Builds the merged qunitx config from package.json settings and CLI flags.
 * `package.json#qunitx.plugins` entries are dynamic-imported into esbuild plugin objects.
 * @returns {Promise<object>}
 */
export async function setup(): Promise<Config> {
  const projectRoot = await findProjectRoot();
  const cliConfigFlags = Args.parse(projectRoot);
  const projectPackageJSON = await readConfigFromPackageJSON(projectRoot);
  const { plugins: rawPlugins, ...userQunitx } =
    (projectPackageJSON.qunitx as Partial<Config> & {
      plugins?: unknown;
    }) ?? {};
  // Kick off plugin resolution before the rest of the config is assembled so dynamic-import
  // latency overlaps with fsTree I/O. For projects with no plugins this is a free no-op.
  const pluginsPromise = resolvePlugins(rawPlugins, projectRoot);
  const inputs = cliConfigFlags.inputs.concat(readInputsFromPackageJSON(projectPackageJSON));
  const config = {
    ...defaultProjectConfigValues,
    htmlPaths: [] as string[],
    ...userQunitx,
    ...cliConfigFlags,
    projectRoot,
    inputs,
    testFileLookupPaths: TestFilePaths.setup(inputs),
    state: RunState.create(),
    // Asserted rather than inferred because fsTree and plugins are filled in by the awaits
    // below — the literal is deliberately partial, and the function's contract is that a
    // complete Config is only guaranteed at the return. The later `as Config` casts this
    // function used to repeat are now redundant.
  } as Config;
  config.htmlPaths = normalizeHTMLPaths(config.projectRoot, config.htmlPaths);
  [config.fsTree, config.plugins] = await Promise.all([
    FSTree.build(config.testFileLookupPaths, config),
    pluginsPromise,
  ]);

  pruneSupersededLineTargets(config);

  // --changed / --since: filter fsTree to test files whose transitive deps
  // include a changed file. Watch mode skips this — watch is for fast feedback
  // on every save, not "what does my working tree affect" semantics.
  if (config.changedSince && !config.watch) {
    config.fsTree = await getChangedFsTree(config.fsTree, config.projectRoot, config.changedSince);
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
function resolvePlugins(raw: unknown, projectRoot: string): Promise<EsbuildPlugin[]> {
  if (raw == null) return Promise.resolve([]);
  if (!Array.isArray(raw)) {
    console.error(`# qunitx: package.json#qunitx.plugins must be an array`);
    process.exit(1);
  }
  const projectRequire = createRequire(`${projectRoot}/package.json`);
  return Promise.all(
    raw.map(async (entry) => {
      const [spec, options] = Array.isArray(entry) ? entry : [entry];
      const mod = await import(pathToFileURL(projectRequire.resolve(spec as string)).href);
      const exported = mod.default ?? mod;
      return typeof exported === 'function' ? exported(options) : exported;
    }),
  );
}
