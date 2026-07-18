import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { red } from './color.ts';

/**
 * Dynamically imports `modulePath` and calls its default export with `params`. A throwing hook
 * exits with code 1 on the CLI; when `embedded` is set it rethrows instead, so the JS API can
 * reject rather than take its host process down with it.
 * @returns {Promise<void>}
 */
export async function runUserModule(
  modulePath: string,
  params: unknown,
  scriptPosition: string,
  embedded = false,
): Promise<void> {
  const { url, cleanup } = await resolveImportTarget(modulePath);
  try {
    const func = await import(url);
    if (func) {
      func.default
        ? await func.default(params)
        : typeof func === 'function'
          ? await func(params)
          : null;
    }
  } catch (error) {
    if (embedded) throw error;
    console.log('#', red(`QUnitX ${scriptPosition} script failed:`));
    console.trace(error);
    console.error(error);

    // Flush stdout before exiting — in piped contexts stdout is buffered and
    // process.exit() can drop pending writes before they reach the OS.
    process.stdout.write('', () => process.exit(1));
  } finally {
    await cleanup();
  }
}

export { runUserModule as default };

/**
 * True when running inside a `deno compile`d binary (vs `deno run script.ts` or
 * plain Node). Detection is on `process.execPath`: under `deno run` it ends with
 * `deno` (or `deno.exe` on Windows); inside a compiled binary it's the user's
 * binary name. `Deno.mainModule` looked tempting but is also a `file:` URL in
 * compiled binaries (a virtual path under `/tmp/deno-compile-<name>/`), so it
 * can't differentiate the two.
 */
export function isDenoCompiledBinary(
  hasDeno: boolean = typeof (globalThis as { Deno?: unknown }).Deno !== 'undefined',
  execPath: string = process.execPath,
): boolean {
  if (!hasDeno) return false;
  return !/[/\\]deno(\.exe)?$/i.test(execPath);
}

/**
 * Resolves a file URL the host can `await import()` directly. Node and `deno
 * run` resolve bare specifiers + TS natively from the user's project, so the
 * file URL passes through unchanged. The deno-compiled binary cannot — its
 * runtime resolver has no view of the user's node_modules and rejects TS
 * syntax in dynamically imported files — so for that path we bundle the user
 * file via esbuild into a self-contained ESM file in a tmp dir and return the
 * bundle's URL plus a cleanup callback. Bundling is one-shot (~50 ms) and only
 * pays the cost where it's actually required.
 */
async function resolveImportTarget(
  modulePath: string,
): Promise<{ url: string; cleanup: () => Promise<void> }> {
  if (!isDenoCompiledBinary()) {
    return { url: pathToFileURL(modulePath).href, cleanup: async () => {} };
  }
  const esbuild = await import('esbuild');
  const stageDir = await mkdtemp(path.join(os.tmpdir(), 'qunitx-user-'));
  // .mjs forces ESM regardless of any ancestor package.json#type so the host
  // loader (Node or Deno's compiled-binary loader) parses the bundle correctly.
  const outfile = path.join(stageDir, 'bundle.mjs');
  // ANCESTOR_NODE_MODULES mirrors tests-in-browser.ts: hands esbuild the same
  // lookup chain Node uses so a user file outside the project root still
  // resolves bare specifiers (e.g. `import 'qunitx'`) from any ancestor.
  const cwd = process.cwd();
  const nodePaths = cwd
    .split(path.sep)
    .map((_, i, parts) =>
      path.join(parts.slice(0, parts.length - i).join(path.sep) || path.sep, 'node_modules'),
    );
  await esbuild.build({
    entryPoints: [modulePath],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    nodePaths,
    logLevel: 'silent',
    // Prefer the `deno` export condition over `node` so package.json conditional
    // exports resolve to their deno-targeted entries when present. qunitx (and
    // similar cross-runtime packages) ship a thinner deno bundle that avoids
    // imports like `node:assert`, which the deno-compile binary only embeds at
    // build time if cli.ts statically references them — a transitive dynamic
    // import from a user --before script otherwise fails at runtime on the
    // OSes whose deno-compile didn't happen to bundle that module
    // (intermittent under macOS specifically). Fallback chain keeps Node
    // resolution working unchanged.
    conditions: ['deno', 'import', 'module', 'node', 'default'],
    // Bundled CJS deps (e.g. `ws` via `qunitx`) call bare `require('events')`.
    // In ESM there is no global `require`; esbuild's `__require` polyfill checks
    // `typeof require !== 'undefined'` and throws otherwise. The banner installs
    // a real `require` at module scope via `createRequire(import.meta.url)`, so
    // built-in lookups resolve through the host's native CJS resolver.
    banner: {
      js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
    },
  });
  return {
    url: pathToFileURL(outfile).href,
    cleanup: () => rm(stageDir, { recursive: true, force: true }).catch(() => {}),
  };
}
