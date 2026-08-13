import fs from 'node:fs/promises';
import path from 'node:path';
import { findProjectRoot } from '../utils/find-project-root.ts';
import { pathExists } from '../utils/path-exists.ts';
import { defaultProjectConfigValues } from '../setup/default-project-config-values.ts';
import { Task } from '../task/index.ts';
import type { ProjectRootNotFoundFailure } from '../utils/find-project-root.ts';
import { readTemplate } from '../utils/read-template.ts';

/**
 * What `init` did, so the caller can report it. Returned rather than printed: the CLI turns
 * these into its messages, and a programmatic caller gets the same facts as data.
 *
 * ```ts
 * const result: InitResult = { written: ['/proj/test/tests.html'], skipped: [] };
 * result.written.length; // 1 — the fixture did not exist yet
 * ```
 */
export interface InitResult {
  /** Absolute paths of the files this call created. */
  written: string[];
  /** Paths that already existed and were left alone. */
  skipped: string[];
}

/**
 * Bootstraps a qunitx project: writes the test HTML template, updates package.json, and writes
 * tsconfig.json when there isn't one.
 *
 * Never overwrites: an existing fixture is reported in `skipped` and left exactly as it was.
 *
 * ```ts
 * import * as Init from './init.ts';
 *
 * // Defined, not invoked: writes into a real project directory.
 * async function initCommand() {
 *   const { written } = await Init.run(); // ['/project/test/tests.html', '/project/tsconfig.json']
 *   return written;
 * }
 * ```
 */
export function run(options: InitOptions = {}): Task<InitResult, ProjectRootNotFoundFailure> {
  return Task(async () => {
    const projectRoot = await findProjectRoot(options.cwd);
    const oldPackageJSON = JSON.parse(await fs.readFile(`${projectRoot}/package.json`, 'utf8'));
    const existingQUnitX = oldPackageJSON.qunitx || {};
    const requestedHtmlPaths =
      options.htmlPaths ?? process.argv.slice(2).filter((arg) => arg.endsWith('.html'));
    const config = Object.assign({}, defaultProjectConfigValues, existingQUnitX, {
      htmlPaths:
        requestedHtmlPaths.length > 0
          ? requestedHtmlPaths
          : existingQUnitX.htmlPaths || ['test/tests.html'],
    });

    const [html, , tsconfig] = await Promise.all([
      writeTestsHTML(projectRoot, config, oldPackageJSON),
      rewritePackageJSON(projectRoot, config, oldPackageJSON),
      writeTSConfigIfNeeded(projectRoot),
    ]);

    return {
      written: [...html.written, ...(tsconfig ? [tsconfig] : [])],
      skipped: html.skipped,
    };
  });
}

/**
 * Where to bootstrap, and which HTML fixtures to write. Both default the way the CLI does:
 * the working directory, and whatever `.html` arguments were passed.
 *
 * ```ts
 * const options: InitOptions = { cwd: '/proj', htmlPaths: ['test/index.html'] };
 * options.htmlPaths; // ['test/index.html'] — written relative to the project root
 * ```
 */
export interface InitOptions {
  /** Directory to find the project root from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** HTML fixtures to create, relative to the project root. Defaults to `['test/tests.html']`. */
  htmlPaths?: string[];
}

async function writeTestsHTML(
  projectRoot: string,
  config: { htmlPaths: string[]; output: string },
  oldPackageJSON: Record<string, unknown>,
): Promise<InitResult> {
  const testHTMLTemplateBuffer = await readTemplate('setup/tests.hbs');
  const outcomes = await Promise.all(
    config.htmlPaths.map(async (htmlPath): Promise<InitResult> => {
      const targetPath = `${projectRoot}/${htmlPath}`;
      // A skip reports the path as given, because that is what the CLI has always printed
      // ("test/tests.html already exists"), while a write reports where it landed.
      if (await pathExists(targetPath)) return { written: [], skipped: [htmlPath] };

      const testHTMLTemplate = testHTMLTemplateBuffer
        .toString()
        .replace('{{applicationName}}', String(oldPackageJSON.name));
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, testHTMLTemplate);

      return { written: [targetPath], skipped: [] };
    }),
  );

  return {
    written: outcomes.flatMap((outcome) => outcome.written),
    skipped: outcomes.flatMap((outcome) => outcome.skipped),
  };
}

async function rewritePackageJSON(
  projectRoot: string,
  config: unknown,
  oldPackageJSON: Record<string, unknown>,
): Promise<void> {
  const newPackageJSON = Object.assign(oldPackageJSON, { qunitx: config });

  await fs.writeFile(`${projectRoot}/package.json`, JSON.stringify(newPackageJSON, null, 2));
}

async function writeTSConfigIfNeeded(projectRoot: string): Promise<string | null> {
  const targetPath = `${projectRoot}/tsconfig.json`;
  if (await pathExists(targetPath)) return null;

  await fs.writeFile(targetPath, await readTemplate('setup/tsconfig.json'));

  return targetPath;
}
