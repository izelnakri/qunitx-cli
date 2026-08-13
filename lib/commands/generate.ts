import fs from 'node:fs/promises';
import { findProjectRoot } from '../utils/find-project-root.ts';
import { pathExists } from '../utils/path-exists.ts';
import { readTemplate } from '../utils/read-template.ts';
import { Task } from '../task/index.ts';
import type { ProjectRootNotFoundFailure } from '../utils/find-project-root.ts';
import { convertToPascalCase } from '../utils/convert-to-pascal-case.ts';

/**
 * What `generate` did: the file it wrote, or the one it refused to overwrite.
 *
 * ```ts
 * const result: GenerateResult = { path: '/proj/test/login-test.js', created: true };
 * result.created; // false would mean the file was already there and was left alone
 * ```
 */
export interface GenerateResult {
  /** Absolute path of the target file. */
  path: string;
  /** `false` when the file already existed and nothing was written. */
  created: boolean;
}

/**
 * Where to scaffold a test file. `target` is a project-relative path; a missing `.js`/`.ts`
 * extension becomes `.js`, and missing directories are created.
 *
 * ```ts
 * const options: GenerateOptions = { target: 'test/login-test' };
 * options.target; // written as test/login-test.js
 * ```
 */
export interface GenerateOptions {
  /** Project-relative path of the test file to write. */
  target: string;
  /** Directory to find the project root from. Defaults to `process.cwd()`. */
  cwd?: string;
}

/**
 * Writes a new test file from the boilerplate template, deriving the QUnit module name from
 * the path. Never overwrites an existing file.
 *
 * ```ts
 * import * as Generate from './generate.ts';
 *
 * // Defined, not invoked: writes into a real project directory.
 * async function generateCommand() {
 *   const { path, created } = await Generate.run({ target: 'test/login-test.ts' });
 *   return created ? path : `${path} already exists`;
 * }
 * ```
 */
export function run(options?: GenerateOptions): Task<GenerateResult, ProjectRootNotFoundFailure> {
  return Task(async () => {
    const target = options?.target ?? process.argv[3];
    const projectRoot = await findProjectRoot(options?.cwd);
    const moduleName = pathToModuleName(target);
    const filePath =
      target.endsWith('.js') || target.endsWith('.ts')
        ? `${projectRoot}/${target}`
        : `${projectRoot}/${target}.js`;

    if (await pathExists(filePath)) return { path: filePath, created: false };

    const testJSContent = await readTemplate('test.js');
    await fs.mkdir(filePath.split('/').slice(0, -1).join('/'), { recursive: true });
    await fs.writeFile(filePath, testJSContent.replace('{{moduleName}}', moduleName));

    return { path: filePath, created: true };
  });
}

function pathToModuleName(filePath: string): string {
  const withoutExt = filePath.replace(/\.(js|ts)$/, '');
  const segments = withoutExt.split('/');
  const targetNames =
    segments[0] === 'test' || segments[0] === 'tests' ? segments.slice(1) : segments;
  return targetNames.map(convertToPascalCase).join(' | ');
}
