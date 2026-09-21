// Loads playwright-core, from beside the running binary when a standalone SEA ships it there.
//
// A SEA keeps playwright-core out of its bundle (it reads its own package.json at runtime), and a
// SEA's bare imports resolve against the CWD — so the npm-installed SEA borrows the project's copy.
// The musl standalone has no project to borrow from, so it carries node_modules/playwright-core
// next to the executable, and this is where that copy gets used. Everywhere else — plain Node,
// Deno, a SEA without the sidecar — it is the ordinary `import('playwright-core')`.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The file URL of a playwright-core shipped in `<execDir>/node_modules`, or null where none is.
 *
 * ```ts
 * import { findSidecarPlaywrightCore } from './import-playwright-core.ts';
 *
 * findSidecarPlaywrightCore('/tmp/no-sidecar-here'); // null
 * ```
 */
export function findSidecarPlaywrightCore(execDir: string): string | null {
  const entry = join(execDir, 'node_modules', 'playwright-core', 'index.mjs');

  return existsSync(entry) ? pathToFileURL(entry).href : null;
}

/**
 * playwright-core, from the running SEA's sidecar when it has one, else resolved as usual.
 *
 * ```ts
 * import { importPlaywrightCore } from './import-playwright-core.ts';
 *
 * // Defined, not invoked: loading playwright-core takes ~150ms.
 * async function example() {
 *   return (await importPlaywrightCore()).chromium; // BrowserType
 * }
 * ```
 */
export function importPlaywrightCore(): Promise<typeof import('playwright-core')> {
  const sidecar = isSea() ? findSidecarPlaywrightCore(dirname(process.execPath)) : null;

  // The literal stays a literal so `deno compile` and esbuild still see the dependency.
  return sidecar ? import(sidecar) : import('playwright-core');
}

/** Whether this is a Node SEA — synchronously, since the import it gates starts at module load. */
function isSea(): boolean {
  try {
    const sea = process.getBuiltinModule?.('node:sea') as { isSea(): boolean } | undefined;

    return sea?.isSea() ?? false;
  } catch {
    return false; // a runtime without node:sea (Deno) is not a SEA
  }
}
