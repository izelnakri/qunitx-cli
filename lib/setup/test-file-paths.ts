import { matchesGlob } from 'node:path';

const GLOB_CHARS = /[*?{[]/;

interface PathMeta {
  input: string;
  globFormat: string;
}

/**
 * Deduplicates a list of file, folder, and glob inputs so that more-specific paths covered by broader ones are removed.
 * @returns {string[]}
 */
export function setupTestFilePaths(inputs: string[]): string[] {
  const folders: PathMeta[] = [];
  const filesWithGlob: PathMeta[] = [];
  const filesWithoutGlob: PathMeta[] = [];

  inputs.forEach((input) => {
    if (!pathIsFile(input)) {
      folders.push({ input, globFormat: `${input}/**` });
    } else if (isGlob(input)) {
      filesWithGlob.push({ input, globFormat: input });
    } else {
      filesWithoutGlob.push({ input, globFormat: input });
    }
  });

  const dedupedFolders = folders.filter((folder) => !isIncludedIn(folders, folder));
  const dedupedGlobFiles = filesWithGlob.filter(
    (file) => !isIncludedIn(dedupedFolders, file) && !isIncludedIn(filesWithGlob, file),
  );
  const dedupedPlainFiles = filesWithoutGlob.reduce<PathMeta[]>((acc, file) => {
    if (
      !isIncludedIn(dedupedFolders, file) &&
      !isIncludedIn(dedupedGlobFiles, file) &&
      !isIncludedIn(acc, file)
    ) {
      acc.push(file);
    }
    return acc;
  }, []);

  return dedupedFolders.concat(dedupedGlobFiles, dedupedPlainFiles).map((meta) => meta.input);
}

export { setupTestFilePaths as default };

function pathIsFile(path: string): boolean {
  return path.includes('.', path.lastIndexOf('/') + 1);
}

function isIncludedIn(paths: PathMeta[], target: PathMeta): boolean {
  return paths.some((path) => path !== target && matchesGlob(target.input, path.globFormat));
}

function isGlob(str: string): boolean {
  return GLOB_CHARS.test(str);
}
