import { matchesGlob } from 'node:path';

function isGlob(str: string): boolean {
  return /[*?{[]/.test(str);
}

interface PathMeta {
  input: string;
  isFile: boolean;
  isGlob: boolean;
}

/**
 * Deduplicates a list of file, folder, and glob inputs so that more-specific paths covered by broader ones are removed.
 * @returns {string[]}
 */
export default function setupTestFilePaths(_projectRoot: string, inputs: string[]): string[] {
  // NOTE: very complex algorithm, order is very important
  const [folders, filesWithGlob, filesWithoutGlob] = inputs.reduce(
    (result, input) => {
      const glob = isGlob(input);

      if (!pathIsFile(input)) {
        result[0].push({ input, isFile: false, isGlob: glob });
      } else {
        result[glob ? 1 : 2].push({ input, isFile: true, isGlob: glob });
      }

      return result;
    },
    [[], [], []],
  );

  const result = folders.reduce((folderResult, folder) => {
    if (!pathIsIncludedInPaths(folders, folder)) {
      folderResult.push(folder);
    }

    return folderResult;
  }, []);

  filesWithGlob.forEach((file) => {
    if (!pathIsIncludedInPaths(result, file) && !pathIsIncludedInPaths(filesWithGlob, file)) {
      result.push(file);
    }
  });
  filesWithoutGlob.forEach((file) => {
    if (!pathIsIncludedInPaths(result, file)) {
      result.push(file);
    }
  });

  return result.map((metaItem) => metaItem.input);
}

function pathIsFile(path: string): boolean {
  const inputs = path.split('/');

  return inputs[inputs.length - 1].includes('.');
}

function pathIsIncludedInPaths(paths: PathMeta[], targetPath: PathMeta): boolean {
  return paths.some((path) => {
    if (path === targetPath) {
      return false;
    }

    return matchesGlob(targetPath.input, buildGlobFormat(path));
  });
}

function buildGlobFormat(path: PathMeta): string {
  return path.isFile ? path.input : `${path.input}/**`;
}
