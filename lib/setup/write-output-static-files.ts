import fs from 'node:fs/promises';
import type { CachedContent } from '../types.ts';

/**
 * Copies static HTML files and referenced assets from the project into the configured output directory.
 * @returns {Promise<void>}
 */
export async function writeOutputStaticFiles(
  { projectRoot, output }: { projectRoot: string; output: string },
  cachedContent: CachedContent,
): Promise<void> {
  const staticHTMLPromises = Object.keys(cachedContent.staticHTMLs).map(async (staticHTMLKey) => {
    const htmlRelativePath = staticHTMLKey.replace(`${projectRoot}/`, '');

    await ensureFolderExists(`${projectRoot}/${output}/${htmlRelativePath}`);
    await fs.writeFile(
      `${projectRoot}/${output}/${htmlRelativePath}`,
      cachedContent.staticHTMLs[staticHTMLKey],
    );
  });
  const assetPromises = Array.from(cachedContent.assets).map(async (assetAbsolutePath) => {
    const assetRelativePath = assetAbsolutePath.replace(`${projectRoot}/`, '');

    await ensureFolderExists(`${projectRoot}/${output}/${assetRelativePath}`);
    await fs.copyFile(assetAbsolutePath, `${projectRoot}/${output}/${assetRelativePath}`);
  });

  await Promise.all(staticHTMLPromises.concat(assetPromises));
}

async function ensureFolderExists(assetPath: string): Promise<void> {
  await fs.mkdir(assetPath.split('/').slice(0, -1).join('/'), { recursive: true });
}

export { writeOutputStaticFiles as default };
