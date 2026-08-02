import process from 'node:process';
import path from 'node:path';
import { Task } from '../task/index.ts';
import * as Failure from '../result/failure.ts';
import { searchInParentDirectories } from './search-in-parent-directories.ts';

/**
 * No `package.json` at or above the working directory, so there is no project to run in.
 *
 * ```ts
 * import { ProjectRootNotFound } from './find-project-root.ts';
 *
 * ProjectRootNotFound.is(ProjectRootNotFound({ cwd: '/tmp' })); // true
 * ```
 */
export const ProjectRootNotFound = Failure.define(
  'ProjectRootNotFound',
  (data: { cwd: string }) =>
    `couldn't find a package.json at or above ${data.cwd} — did you run \`npm init\`?`,
);

/** The one failure {@link findProjectRoot} declares. */
export type ProjectRootNotFoundFailure = Failure.Of<typeof ProjectRootNotFound>;

/**
 * Walks up from the working directory to the nearest `package.json` and resolves to its directory.
 *
 * Missing it is a declared outcome, not a crash. This used to `console.log` a hint and
 * `process.exit(1)` from inside a library function — untestable, and unanswerable by the
 * daemon, which serves many projects and must not die because one of them lacks a manifest.
 *
 * ```ts
 * import { findProjectRoot } from './find-project-root.ts';
 * import * as Failure from '../result/failure.ts';
 *
 * // Defined, not invoked: walks the real filesystem.
 * async function resolveRoot() {
 *   const root = await findProjectRoot().result();
 *   return Failure.is(root) ? root.code : root; // 'ProjectRootNotFound', or '/home/user/project'
 * }
 * ```
 */
export function findProjectRoot(): Task<string, ProjectRootNotFoundFailure> {
  return Task(async () => {
    const absolutePath = await searchInParentDirectories('.', 'package.json');
    if (!absolutePath?.includes('package.json')) throw new Error('no package.json found');

    // path.dirname strips the basename using the platform separator — `.replace('/package.json', '')`
    // missed Windows paths like `C:\foo\package.json`, leaving the literal filename in the result.
    return path.dirname(absolutePath);
  }).mapErr(ProjectRootNotFound, { cwd: process.cwd() });
}
