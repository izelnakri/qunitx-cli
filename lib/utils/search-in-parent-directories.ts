import { pathExists } from './path-exists.ts';

/**
 * Recursively searches `directory` and its ancestors for a file or folder named `targetEntry`; returns the absolute path or `undefined`.
 * @returns {Promise<string|undefined>}
 */
export async function searchInParentDirectories(
  directory: string,
  targetEntry: string,
): Promise<string | undefined> {
  const resolvedDirectory = directory === '.' ? process.cwd() : directory;

  if (await pathExists(`${resolvedDirectory}/${targetEntry}`)) {
    return `${resolvedDirectory}/${targetEntry}`;
  } else if (resolvedDirectory === '') {
    return;
  }

  return await searchInParentDirectories(
    resolvedDirectory.slice(0, resolvedDirectory.lastIndexOf('/')),
    targetEntry,
  );
}

export { searchInParentDirectories as default };
