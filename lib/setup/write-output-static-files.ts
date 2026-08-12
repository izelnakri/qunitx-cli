import fs from 'node:fs/promises';
import path from 'node:path';
import { readTemplate } from '../utils/read-template.ts';
import type { HtmlAssets } from '../types.ts';

/**
 * Copies static HTML files and referenced assets from the project into the configured output directory.
 *
 * ```ts
 * import type { HtmlAssets } from '../types.ts';
 *
 * // Defined, not invoked: writes into the real output directory.
 * async function example(htmlAssets: HtmlAssets) {
 *   await writeOutputStaticFiles({ projectRoot: '/proj', output: 'tmp' }, htmlAssets);
 *   // each static HTML + referenced asset now lives under /proj/tmp/
 * }
 * ```
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
    await copyAsset(assetAbsolutePath, destPath);
  });

  await Promise.all(staticHTMLPromises.concat(assetPromises));
}

async function ensureFolderExists(assetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(assetPath), { recursive: true });
}

/**
 * Copies one referenced asset, tolerating a source that is not on disk.
 *
 * `qunitx init` writes a page that links `node_modules/qunitx/vendor/qunit.css`, which only exists
 * when the project installed `qunitx` itself — a globally-installed CLI in a fresh project has no
 * such file, and copying it blindly failed the whole run before any test could report. The server
 * already answers that URL from the CLI's embedded copy; the static output now does the same.
 *
 * Any other missing asset is skipped rather than fatal. A page referencing a stylesheet that is not
 * there renders unstyled, which is the page's problem; it is not a reason to fail the test run, and
 * the server treats the same request as a 404 rather than an error.
 */
async function copyAsset(source: string, destination: string): Promise<void> {
  try {
    await fs.copyFile(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    else if (source.endsWith(path.join('qunitx', 'vendor', 'qunit.css'))) {
      await fs.writeFile(destination, await readTemplate('vendor/qunit.css'));
    }
  }
}
