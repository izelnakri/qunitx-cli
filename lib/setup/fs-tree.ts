import fs, { glob as fsGlob } from 'node:fs/promises';
import path from 'node:path';
import type { FSTree } from '../types.ts';

function isGlob(str: string): boolean {
  return /[*?{[]/.test(str);
}

async function readDirRecursive(dir: string, filter: (name: string) => boolean): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && filter(e.name))
    .map((e) => path.join(e.parentPath, e.name));
}

/**
 * Resolves an array of file paths, directories, or glob patterns into a flat `{ absolutePath: null }` map.
 * @returns {Promise<object>}
 */
export default async function buildFSTree(
  fileAbsolutePaths: string[],
  config: { extensions?: string[] } = {},
): Promise<FSTree> {
  const targetExtensions = config.extensions || ['js', 'ts'];
  const fsTree = {};

  await Promise.all(
    fileAbsolutePaths.map(async (fileAbsolutePath) => {
      try {
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
      } catch (error) {
        console.error(error);

        return process.exit(1);
      }
    }),
  );

  return fsTree;
}
