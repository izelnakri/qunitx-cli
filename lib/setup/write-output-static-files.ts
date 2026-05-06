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
    // read+write rather than copyFile: the `Deno.copyFile` shim under
    // deno-compile binaries on Windows fails with INVALID_HANDLE (os error 6)
    // when the source path traverses `node_modules/.deno/<pkg>/...` (the
    // layout used by `deno install`). Buffering the content trades a small
    // amount of memory for a syscall path that works portably on every
    // runtime + platform we ship for. Node-side performance is unchanged in
    // practice — these assets are kilobyte-scale (qunit.css ≈ 8 KB) and the
    // copy happens once per output dir setup.
    await fs.writeFile(destPath, await fs.readFile(assetAbsolutePath));
  });

  await Promise.all(staticHTMLPromises.concat(assetPromises));
}

export { writeOutputStaticFiles as default };

async function ensureFolderExists(assetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(assetPath), { recursive: true });
}
