import fs from 'node:fs/promises';
import { defaultProjectConfigValues } from './default-project-config-values.ts';
import { findProjectRoot } from '../utils/find-project-root.ts';
import { buildFSTree } from './fs-tree.ts';
import { setupTestFilePaths } from './test-file-paths.ts';
import { parseCliFlags } from '../utils/parse-cli-flags.ts';
import type { Config } from '../types.ts';

/**
 * Builds the merged qunitx config from package.json settings and CLI flags.
 * @returns {Promise<object>}
 */
export async function setupConfig(): Promise<Config> {
  const projectRoot = await findProjectRoot();
  const cliConfigFlags = parseCliFlags(projectRoot);
  const projectPackageJSON = await readConfigFromPackageJSON(projectRoot);
  const inputs = cliConfigFlags.inputs.concat(readInputsFromPackageJSON(projectPackageJSON));
  const config = {
    ...defaultProjectConfigValues,
    htmlPaths: [] as string[],
    ...((projectPackageJSON.qunitx as Partial<Config>) || {}),
    ...cliConfigFlags,
    projectRoot,
    inputs,
    testFileLookupPaths: setupTestFilePaths(projectRoot, inputs),
    lastFailedTestFiles: null as string[] | null,
    lastRanTestFiles: null as string[] | null,
    COUNTER: { testCount: 0, failCount: 0, skipCount: 0, passCount: 0, errorCount: 0 },
    _testRunDone: null as (() => void) | null,
    _resetTestTimeout: null as (() => void) | null,
    _onWsOpen: null as (() => void) | null,
    _onTestsJsServed: null as (() => void) | null,
  };
  config.htmlPaths = normalizeHTMLPaths(config.projectRoot, config.htmlPaths);
  config.fsTree = await buildFSTree(config.testFileLookupPaths, config);

  return config as Config;
}

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

export { setupConfig as default };
