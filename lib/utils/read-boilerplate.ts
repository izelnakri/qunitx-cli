import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Reads a boilerplate file by relative path, using the SEA asset store when running as a Node.js binary.
 * @returns {Promise<string>}
 */
export default async function readBoilerplate(relativePath: string): Promise<string> {
  const sea = await import('node:sea').catch(() => null);
  if (sea?.isSea()) return sea.getAsset(relativePath, 'utf8');
  return (await fs.readFile(join(__dirname, '../../templates', relativePath))).toString();
}
