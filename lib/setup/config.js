import fs from 'node:fs/promises';
import defaultProjectConfigValues from '../boilerplates/default-project-config-values.js';
import findProjectRoot from '../utils/find-project-root.js';
import setupFSTree from './fs-tree.js';
import setupTestFilePaths from './test-file-paths.js';
import parseCliFlags from '../utils/parse-cli-flags.js';

/**
 * Builds the merged qunitx config from package.json settings and CLI flags.
 * @returns {Promise<object>}
 */
export default async function setupConfig() {
  const projectRoot = await findProjectRoot();
  const cliConfigFlags = parseCliFlags(projectRoot);
  const projectPackageJSON = await readConfigFromPackageJSON(projectRoot);
  const inputs = cliConfigFlags.inputs.concat(readInputsFromPackageJSON(projectPackageJSON));
  const config = {
    ...defaultProjectConfigValues,
    htmlPaths: [],
    ...projectPackageJSON.qunitx,
    ...cliConfigFlags,
    projectRoot,
    inputs,
    testFileLookupPaths: setupTestFilePaths(projectRoot, inputs),
    lastFailedTestFiles: null,
    lastRanTestFiles: null,
  };
  config.htmlPaths = normalizeHTMLPaths(config.projectRoot, config.htmlPaths);
  config.fsTree = await setupFSTree(config.testFileLookupPaths, config);

  return config;
}

async function readConfigFromPackageJSON(projectRoot) {
  const packageJSON = await fs.readFile(`${projectRoot}/package.json`);

  return JSON.parse(packageJSON.toString());
}

function normalizeHTMLPaths(projectRoot, htmlPaths) {
  return Array.from(new Set(htmlPaths.map((htmlPath) => `${projectRoot}/${htmlPath}`)));
}

function readInputsFromPackageJSON(packageJSON) {
  const qunitx = packageJSON.qunitx;

  return qunitx && qunitx.inputs ? qunitx.inputs : [];
}
