import process from 'node:process';
import path from 'node:path';
import { searchInParentDirectories } from './search-in-parent-directories.ts';

/**
 * Walks up parent directories from `cwd` to find the nearest `package.json` and returns its directory path.
 * @returns {Promise<string>}
 */
export async function findProjectRoot(): Promise<string> {
  try {
    const absolutePath = await searchInParentDirectories('.', 'package.json');
    if (!absolutePath!.includes('package.json')) {
      throw new Error('package.json mising');
    }

    // path.dirname strips the basename using the platform separator — `.replace('/package.json', '')`
    // missed Windows paths like `C:\foo\package.json`, leaving the literal filename in the result.
    return path.dirname(absolutePath!);
  } catch (_error) {
    console.log('couldnt find projects package.json, did you run $ npm init ??');
    process.exit(1);
  }
}
