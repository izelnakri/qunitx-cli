import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reads a boilerplate file by relative path, using the SEA asset store when running as a Node.js binary.
 * @returns {Promise<string>}
 */
export default async function readBoilerplate(relativePath: string): Promise<string> {
  const sea = await import('node:sea').catch(() => null);
  if (sea?.isSea()) return sea.getAsset(relativePath, 'utf8');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // When running from source (lib/utils/), templates are 2 levels up.
  // When running from the npm bundle (dist/), import.meta.url resolves to the
  // bundle file so __dirname is dist/ — only 1 level up to the package root.
  for (const base of ['../templates', '../../templates']) {
    try {
      return (await fs.readFile(join(__dirname, base, relativePath))).toString();
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `qunitx-cli: template "${relativePath}" not found — try reinstalling the package.`,
  );
}
