#!/usr/bin/env node
// Bundles cli.ts into dist/cli.js and the JS API into dist/index.js for npm distribution.
// All local TypeScript is bundled and types are stripped by esbuild. npm dependencies
// (esbuild, playwright-core, ws) remain external so they continue to be resolved from the
// consumer's node_modules at runtime.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const EXTERNAL = ['esbuild', 'playwright-core', 'ws'];

await mkdir('dist', { recursive: true });

await Promise.all([
  build({
    entryPoints: ['cli.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: 'dist/cli.js',
    external: EXTERNAL,
    logLevel: 'warning',
  }),
  build({
    entryPoints: ['lib/api/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: 'dist/index.js',
    external: EXTERNAL,
    logLevel: 'warning',
  }),
]);

console.log('Built dist/cli.js');
console.log('Built dist/index.js');

await buildTypeDeclarations();

/**
 * Emits `.d.ts` for the JS API into `dist/types/`.
 *
 * tsc's exit code is ignored on purpose: the repo typechecks with `deno check` (which supplies
 * Node's types via its own lib) and carries pre-existing tsc diagnostics in modules unrelated to
 * the API. Declaration emit still produces correct output alongside them, so the build asserts on
 * the artifact existing rather than on tsc's status.
 */
async function buildTypeDeclarations() {
  const outDir = 'dist/types';
  spawnSync(
    'npx',
    [
      'tsc',
      '--emitDeclarationOnly',
      '--declaration',
      '--skipLibCheck',
      '--allowImportingTsExtensions',
      '--types',
      'node',
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      '--target',
      'esnext',
      '--rootDir',
      '.',
      '--outDir',
      outDir,
      'lib/api/index.ts',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' },
  );

  const entry = path.join(outDir, 'lib/api/index.d.ts');
  await rewriteTsSpecifiers(outDir);
  console.log(`Built ${entry}`);
}

/**
 * Rewrites `./foo.ts` import specifiers to `./foo.js` across the emitted declarations. The
 * sources import with explicit `.ts` extensions (Node's native TypeScript loader requires them),
 * which a consumer's TypeScript rejects unless it opts into `allowImportingTsExtensions`.
 * `./foo.js` resolves to `foo.d.ts` under every module resolution mode, so the rewrite is what
 * makes these declarations consumable from an ordinary project.
 */
async function rewriteTsSpecifiers(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.d.ts'))
      .map(async (entry) => {
        const filePath = path.join(entry.parentPath, entry.name);
        const source = await readFile(filePath, 'utf8');
        const rewritten = source.replace(
          /(from\s+['"])(\.[^'"]*)\.ts(['"])/g,
          (_match, prefix, specifier, quote) => `${prefix}${specifier}.js${quote}`,
        );
        if (rewritten !== source) await writeFile(filePath, rewritten);
      }),
  );
}
