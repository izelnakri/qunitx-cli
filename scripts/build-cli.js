#!/usr/bin/env node
// Builds the two npm entry points and the type declarations for the JS API.
//
//   dist/cli.js    ← cli.ts          the `qunitx` binary's fallback entry
//   dist/index.js  ← lib/api/index.ts  what `import 'qunitx-cli'` resolves to
//   dist/types/    ← lib/api/index.ts  .d.ts tree for the same
//
// All local TypeScript is bundled and types are stripped by esbuild. npm dependencies
// (esbuild, playwright-core, ws) remain external so they continue to be resolved from the
// consumer's node_modules at runtime.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const EXTERNAL = ['esbuild', 'playwright-core', 'ws'];
const TYPES_DIR = 'dist/types';
const API_ENTRY = 'lib/api/index.ts';

await mkdir('dist', { recursive: true });

// The bundles and the declarations read the same sources but write different trees, so nothing
// downstream waits on the other — `tsc` is the slow half and now overlaps esbuild rather than
// following it.
await Promise.all([buildBundles(), buildTypes()]);

/** Bundles both npm entry points. */
async function buildBundles() {
  await Promise.all(
    [
      { entryPoints: ['cli.ts'], outfile: 'dist/cli.js' },
      { entryPoints: [API_ENTRY], outfile: 'dist/index.js' },
    ].map((entry) =>
      build({
        ...entry,
        bundle: true,
        platform: 'node',
        format: 'esm',
        external: EXTERNAL,
        logLevel: 'warning',
      }),
    ),
  );
  console.log('Built dist/cli.js and dist/index.js');
}

/**
 * Emits the API's `.d.ts` tree.
 *
 * `--noCheck` because this is an emit, not a gate: `npm run typecheck` (deno check, including
 * every doc example) is what decides whether the types are right, and running a second, slower
 * checker here would only produce a second opinion to reconcile.
 *
 * Flags rather than a tsconfig.json, so the repo keeps one source of truth for how its
 * TypeScript is configured instead of gaining a second one that only the build reads.
 */
async function buildTypes() {
  const status = await new Promise((resolve, reject) => {
    const tsc = spawn(
      process.execPath,
      [
        path.join('node_modules', 'typescript', 'bin', 'tsc'),
        API_ENTRY,
        '--declaration',
        '--emitDeclarationOnly',
        '--noCheck',
        '--skipLibCheck',
        '--outDir',
        TYPES_DIR,
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        '--target',
        'esnext',
        '--allowImportingTsExtensions',
      ],
      { stdio: 'inherit' },
    );
    tsc.once('error', reject);
    tsc.once('close', resolve);
  });
  if (status !== 0) throw new Error(`tsc declaration emit failed (${status})`);

  await rewriteTsSpecifiers(TYPES_DIR);
  console.log(`Built ${TYPES_DIR}/`);
}

/**
 * Rewrites `./x.ts` specifiers to `./x.js` throughout the emitted declarations.
 *
 * The source imports carry explicit `.ts` extensions (Node 24 and Deno both want them), and
 * `--rewriteRelativeImportExtensions` is not honoured by the TypeScript 7 compiler this repo
 * pins — so the emitted `.d.ts` files inherit specifiers that a consumer's resolver, which has
 * no `allowImportingTsExtensions`, cannot follow. Rewriting them here is what makes the shipped
 * types resolvable from an ordinary project.
 */
async function rewriteTsSpecifiers(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return rewriteTsSpecifiers(entryPath);
      if (!entry.name.endsWith('.d.ts')) return;

      const source = await readFile(entryPath, 'utf8');
      // Anchored on `from`/`import(` plus a relative prefix, so a bare `.ts` mention in prose is
      // left alone. An `import … from './x.ts'` inside a doc example is rewritten along with the
      // real ones, which is right: a reader of the shipped declarations is importing the built
      // `.js`, not the source.
      const rewritten = source.replace(
        /(\bfrom\s+|\bimport\s*\()(['"])(\.\.?\/[^'"]+)\.ts\2/g,
        (_match, keyword, quote, specifier) => `${keyword}${quote}${specifier}.js${quote}`,
      );
      if (rewritten !== source) await writeFile(entryPath, rewritten);
    }),
  );
}
