import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { defaultProjectConfigValues } from './default-project-config-values.ts';
import { findProjectRoot } from '../utils/find-project-root.ts';
import { buildFSTree } from './fs-tree.ts';
import { setupTestFilePaths } from './test-file-paths.ts';
import { parseCliFlags } from '../utils/parse-cli-flags.ts';
import type { Config } from '../types.ts';
import type { Plugin as EsbuildPlugin } from 'esbuild';

/**
 * Builds the merged qunitx config from package.json settings and CLI flags.
 * `package.json#qunitx.plugins` entries are dynamic-imported into esbuild plugin objects.
 * @returns {Promise<object>}
 */
export async function setupConfig(): Promise<Config> {
  const projectRoot = await findProjectRoot();
  const cliConfigFlags = parseCliFlags(projectRoot);
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
    testFileLookupPaths: setupTestFilePaths(inputs),
    lastFailedTestFiles: null as string[] | null,
    lastRanTestFiles: null as string[] | null,
    COUNTER: {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    },
    _testRunDone: null as (() => void) | null,
    _resetTestTimeout: null as (() => void) | null,
    _onWsOpen: null as (() => void) | null,
    _onTestsJsServed: null as (() => void) | null,
  };
  config.htmlPaths = normalizeHTMLPaths(config.projectRoot, config.htmlPaths);
  [config.fsTree, config.plugins] = await Promise.all([
    buildFSTree(config.testFileLookupPaths, config),
    pluginsPromise,
  ]);

  return config as Config;
}

export { setupConfig as default };

async function readConfigFromPackageJSON(projectRoot: string) {
  const packageJSON = await fs.readFile(`${projectRoot}/package.json`);

  return JSON.parse(packageJSON.toString()) as { qunitx?: unknown; [key: string]: unknown };
}

function normalizeHTMLPaths(projectRoot: string, htmlPaths: string[]): string[] {
  return Array.from(new Set(htmlPaths.map((htmlPath) => `${projectRoot}/${htmlPath}`)));
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
