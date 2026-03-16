import pathExists from './path-exists.js';

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
