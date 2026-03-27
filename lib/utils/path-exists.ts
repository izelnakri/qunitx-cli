import fs from 'node:fs/promises';

/**
 * Returns `true` if the given filesystem path is accessible, `false` otherwise.
 * @example
 * ```js
 * import pathExists from './lib/utils/path-exists.ts';
 * console.assert(await pathExists('/tmp') === true);
 * console.assert(await pathExists('/tmp/nonexistent-qunitx-file') === false);
 * ```
 * @returns {Promise<boolean>}
 */
export default async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);

    return true;
  } catch {
    return false;
  }
}
