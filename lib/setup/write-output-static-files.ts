import fs from 'node:fs/promises';
import path from 'node:path';
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
    const htmlRelativePath = path.relative(projectRoot, staticHTMLKey);

    const outDir = path.resolve(projectRoot, output);
    await ensureFolderExists(path.join(outDir, htmlRelativePath));
    await fs.writeFile(
      path.join(outDir, htmlRelativePath),
      cachedContent.staticHTMLs[staticHTMLKey],
    );
  });
  const assetPromises = Array.from(cachedContent.assets).map(async (assetAbsolutePath) => {
    const assetRelativePath = path.relative(projectRoot, assetAbsolutePath);
    const outDir = path.resolve(projectRoot, output);
    await ensureFolderExists(path.join(outDir, assetRelativePath));
    await fs.copyFile(assetAbsolutePath, path.join(outDir, assetRelativePath));
  });

  await Promise.all(staticHTMLPromises.concat(assetPromises));
}

export { writeOutputStaticFiles as default };

async function ensureFolderExists(assetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(assetPath), { recursive: true });
}
