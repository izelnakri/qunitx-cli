import { isSea, getAsset } from 'node:sea';
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default async function readBoilerplate(relativePath) {
  if (isSea()) return getAsset(relativePath, 'utf8');
  return (await fs.readFile(join(__dirname, '../boilerplates', relativePath))).toString();
}
