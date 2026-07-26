import fs from 'node:fs/promises';

/**
 * Returns `true` if the given filesystem path is accessible, `false` otherwise.
 *
 * ```ts
 * await pathExists('/tmp'); // true
 * await pathExists('/tmp/nonexistent-qunitx-file'); // false — any access failure reads as absent
 * ```
 * @returns {Promise<boolean>}
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);

    return true;
  } catch {
    return false;
  }
}
