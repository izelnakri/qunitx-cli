import fs from 'node:fs/promises';
import path from 'node:path';
import type { HtmlAssets } from '../types.ts';

/**
 * Copies static HTML files and referenced assets from the project into the configured output directory.
 * @returns {Promise<void>}
 */
export async function writeOutputStaticFiles(
  { projectRoot, output }: { projectRoot: string; output: string },
  htmlAssets: HtmlAssets,
): Promise<void> {
  const staticHTMLPromises = Object.keys(htmlAssets.staticHTMLs).map(async (staticHTMLKey) => {
    const htmlRelativePath = path.relative(projectRoot, staticHTMLKey);

    const outDir = path.resolve(projectRoot, output);
    await ensureFolderExists(path.join(outDir, htmlRelativePath));
    await fs.writeFile(path.join(outDir, htmlRelativePath), htmlAssets.staticHTMLs[staticHTMLKey]);
  });
  const assetPromises = Array.from(htmlAssets.assets).map(async (assetAbsolutePath) => {
    // When the asset lives outside projectRoot — pnpm/yarn workspaces with a
    // hoisted `node_modules`, npm-link'd dev deps, or test fixtures that
    // symlink `node_modules` — `path.relative` returns leading `..` segments.
    // Joining those onto outDir cancels its trailing segments, so distinct
    // group outputs would converge on the same on-disk path AND the served
    // file wouldn't match the URL the browser requests. Strip the leading
    // escape so the asset always lands at `<outDir>/<rest>`.
    const assetRelativePath = path
      .relative(projectRoot, assetAbsolutePath)
      .replace(/^(?:\.\.[\\/])+/, '');
    const outDir = path.resolve(projectRoot, output);
    const destPath = path.join(outDir, assetRelativePath);
    await ensureFolderExists(destPath);
    await fs.copyFile(assetAbsolutePath, destPath);
  });

  await Promise.all(staticHTMLPromises.concat(assetPromises));
}

export { writeOutputStaticFiles as default };

async function ensureFolderExists(assetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(assetPath), { recursive: true });
}
