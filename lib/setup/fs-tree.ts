import fs, { glob as fsGlob } from 'node:fs/promises';
import path from 'node:path';
import { Task } from '../task/index.ts';
import * as Failure from '../result/failure.ts';
import { defaultProjectConfigValues } from './default-project-config-values.ts';
import type { FSTree } from '../types.ts';

/**
 * One of the configured test inputs could not be globbed, stat'd or walked.
 *
 * ```ts
 * import { InputUnreadable } from './fs-tree.ts';
 *
 * InputUnreadable({ input: 'test/**' }).message; // "could not read test input test/**"
 * ```
 */
export const InputUnreadable = Failure.define(
  'InputUnreadable',
  (data: { input: string }) => `could not read test input ${data.input}`,
);

/** The one failure {@link build} declares. */
export type InputUnreadableFailure = Failure.Of<typeof InputUnreadable>;

/**
 * Resolves an array of file paths, directories, or glob patterns into a flat `{ absolutePath: null }` map.
 *
 * Each input is walked as its own Task, so the one that failed names itself in the failure's
 * `data` — the previous `console.error(error); process.exit(1)` printed a bare ENOENT with no
 * indication of which of the configured inputs produced it, and took the daemon down with it.
 *
 * ```ts
 * import * as FSTree from './fs-tree.ts';
 *
 * // Defined, not invoked: stats and walks the real filesystem.
 * function discover(projectRoot: string) {
 *   return FSTree.build([`${projectRoot}/test/**`, `${projectRoot}/lib/util-test.ts`]);
 *   // { '/proj/test/cart-test.ts': null, '/proj/lib/util-test.ts': null, … }
 * }
 * ```
 */
export function build(
  fileAbsolutePaths: string[],
  config: { extensions?: string[] } = {},
): Task<FSTree, InputUnreadableFailure> {
  const targetExtensions = config.extensions || defaultProjectConfigValues.extensions;
  const fsTree: FSTree = {};

  return Task.all(
    fileAbsolutePaths.map((fileAbsolutePath) =>
      Task(async () => {
        if (isGlob(fileAbsolutePath)) {
          for await (const fileName of fsGlob(fileAbsolutePath)) {
            if (targetExtensions.some((ext) => fileName.endsWith(`.${ext}`))) {
              fsTree[fileName] = null;
            }
          }
        } else {
          const entry = await fs.stat(fileAbsolutePath);

          if (entry.isFile()) {
            fsTree[fileAbsolutePath] = null;
          } else if (entry.isDirectory()) {
            const fileNames = await readDirRecursive(fileAbsolutePath, (name) => {
              return targetExtensions.some((extension) => name.endsWith(`.${extension}`));
            });

            fileNames.forEach((fileName) => {
              fsTree[fileName] = null;
            });
          }
        }
      }).mapErr(InputUnreadable, { input: fileAbsolutePath }),
    ),
  ).map(() => fsTree);
}

function isGlob(str: string): boolean {
  return /[*?{[]/.test(str);
}

async function readDirRecursive(dir: string, filter: (name: string) => boolean): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  const candidates = entries.filter(
    (dirent) => (dirent.isFile() || dirent.isSymbolicLink()) && filter(dirent.name),
  );

  const resolvedPaths = await Promise.all(
    candidates.map(async (dirent) => {
      const fullPath = path.join(dirent.parentPath, dirent.name);
      if (dirent.isFile()) return fullPath;
      // Symlink — follow it and verify it resolves to a file, not a directory or a broken target.
      try {
        const statResult = await fs.stat(fullPath);
        return statResult.isFile() ? fullPath : null;
      } catch {
        return null; // dangling symlink — skip
      }
    }),
  );

  return resolvedPaths.filter((resolvedPath): resolvedPath is string => resolvedPath !== null);
}
