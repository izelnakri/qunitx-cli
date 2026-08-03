import * as Init from '../commands/init.ts';
import * as Generate from '../commands/generate.ts';
import { Task } from '../task/index.ts';
import type { ProjectRootNotFoundFailure } from '../utils/find-project-root.ts';

export type { InitOptions, InitResult } from '../commands/init.ts';
export type { GenerateOptions, GenerateResult } from '../commands/generate.ts';

/**
 * Bootstraps a project for qunitx: writes the test HTML fixture, adds a `qunitx` block to
 * `package.json`, and writes a `tsconfig.json` when there isn't one.
 *
 * Never overwrites. Files that already exist come back under `skipped`, untouched — so calling
 * it twice is safe, and calling it on an existing project only fills in what is missing.
 *
 * ```ts
 * import { init } from './scaffold.ts';
 *
 * // Defined, not invoked: writes into a real project directory.
 * async function bootstrap() {
 *   const { written, skipped } = await init({ cwd: '/proj' });
 *   return { created: written.length, left: skipped.length };
 * }
 * ```
 */
export function init(
  options: Init.InitOptions = {},
): Task<Init.InitResult, ProjectRootNotFoundFailure> {
  return Task(() => Init.run(options));
}

/**
 * Writes a new test file from the boilerplate template, deriving its QUnit module name from the
 * path (`test/users/login-test.ts` → `Users | Login`). Creates missing directories; never
 * overwrites an existing file.
 *
 * ```ts
 * import { generate } from './scaffold.ts';
 *
 * // Defined, not invoked: writes into a real project directory.
 * async function scaffold() {
 *   const { path, created } = await generate({ target: 'test/login-test.ts' });
 *   return created ? path : null;
 * }
 * ```
 */
export function generate(
  options: Generate.GenerateOptions,
): Task<Generate.GenerateResult, ProjectRootNotFoundFailure> {
  return Task(() => Generate.run(options));
}
