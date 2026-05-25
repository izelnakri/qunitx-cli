import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Deno API surface used below. Defined lazily so the cast at the call site
// stays narrow; `Deno` itself may be undefined under Node.
type DenoGlobal = { readFile(path: string): Promise<Uint8Array> };
const DENO = (globalThis as { Deno?: DenoGlobal }).Deno;

/**
 * Reads a template file by relative path. Three runtimes to satisfy:
 *  - Node SEA binary: assets live in the SEA store (node:sea).
 *  - Deno (`deno run` or `deno compile` binary): the deno-compile virtual
 *    filesystem exposes embedded files via Deno.readFile but rejects
 *    `node:fs/promises.readFile` with "not supported"; Deno.readFile also works
 *    transparently for regular files under non-compiled `deno run`, so we use
 *    one code path for both.
 *  - Node from source/npm: regular fs.readFile.
 *
 * The two `__dirname`-relative bases cover (a) running from source where
 * templates are 2 levels above lib/utils/, and (b) running from the bundled
 * dist/ where __dirname is the package root so templates are only 1 level up.
 */
export async function readTemplate(relativePath: string): Promise<string> {
  const sea = await import('node:sea').catch(() => null);
  if (sea?.isSea()) return sea.getAsset(relativePath, 'utf8');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  for (const base of ['../templates', '../../templates']) {
    const candidate = join(__dirname, base, relativePath);
    try {
      if (DENO) return new TextDecoder().decode(await DENO.readFile(candidate));
      return (await fs.readFile(candidate)).toString();
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `qunitx-cli: template "${relativePath}" not found — try reinstalling the package.`,
  );
}

export { readTemplate as default };
