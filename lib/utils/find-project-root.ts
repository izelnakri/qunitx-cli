import process from 'node:process';
import path from 'node:path';
import { searchInParentDirectories } from './search-in-parent-directories.ts';

/**
 * Walks up parent directories from `startDirectory` to find the nearest `package.json` and
 * returns its directory path. Exits the process when there is none; `embedded` makes it throw
 * instead, so the JS API can reject rather than kill its host.
 * @returns {Promise<string>}
 */
export async function findProjectRoot(startDirectory = '.', embedded = false): Promise<string> {
  try {
    const absolutePath = await searchInParentDirectories(startDirectory, 'package.json');
    if (!absolutePath!.includes('package.json')) {
      throw new Error('package.json mising');
    }

    // path.dirname strips the basename using the platform separator — `.replace('/package.json', '')`
    // missed Windows paths like `C:\foo\package.json`, leaving the literal filename in the result.
    return path.dirname(absolutePath!);
  } catch (_error) {
    const message = `qunitx: no package.json found at or above ${startDirectory} — did you run \`npm init\`?`;
    if (embedded) throw new Error(message);
    console.log('couldnt find projects package.json, did you run $ npm init ??');
    process.exit(1);
  }
}

export { findProjectRoot as default };
