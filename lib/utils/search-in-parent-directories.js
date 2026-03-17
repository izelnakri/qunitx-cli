import pathExists from './path-exists.js';

/**
 * Recursively searches `directory` and its ancestors for a file or folder named `targetEntry`; returns the absolute path or `undefined`.
 * @returns {Promise<string|undefined>}
 */
async function searchInParentDirectories(directory, targetEntry) {
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

export default searchInParentDirectories;
