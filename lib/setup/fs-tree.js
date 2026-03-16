import fs from 'node:fs/promises';
import picomatch from 'picomatch';
import recursiveLookup from 'recursive-lookup';

export default async function buildFSTree(fileAbsolutePaths, _config = {}) {
  const targetExtensions = ['js', 'ts'];
  const fsTree = {};

  await Promise.all(
    fileAbsolutePaths.map(async (fileAbsolutePath) => {
      const glob = picomatch.scan(fileAbsolutePath);

      // TODO: maybe allow absolute path references

      try {
        if (glob.isGlob) {
          const fileNames = await recursiveLookup(glob.base, (path) => {
            return targetExtensions.some((extension) => path.endsWith(extension));
          });

          fileNames.forEach((fileName) => {
            if (picomatch.isMatch(fileName, fileAbsolutePath, { bash: true })) {
              fsTree[fileName] = null;
            }
          });
        } else {
          const entry = await fs.stat(fileAbsolutePath);

          if (entry.isFile()) {
            fsTree[fileAbsolutePath] = null;
          } else if (entry.isDirectory()) {
            const fileNames = await recursiveLookup(glob.base, (path) => {
              return targetExtensions.some((extension) => path.endsWith(extension));
            });

            fileNames.forEach((fileName) => {
              fsTree[fileName] = null;
            });
          }
        }
      } catch (error) {
        console.error(error);

        return process.exit(1);
      }
    }),
  );

  return fsTree;
}
