import process from 'node:process';
import searchInParentDirectories from './search-in-parent-directories.js';

/**
 * Walks up parent directories from `cwd` to find the nearest `package.json` and returns its directory path.
 * @returns {Promise<string>}
 */
export default async function findProjectRoot() {
  try {
    const absolutePath = await searchInParentDirectories('.', 'package.json');
    if (!absolutePath.includes('package.json')) {
      throw new Error('package.json mising');
    }

    return absolutePath.replace('/package.json', '');
  } catch (_error) {
    console.log('couldnt find projects package.json, did you run $ npm init ??');
    process.exit(1);
  }
}
