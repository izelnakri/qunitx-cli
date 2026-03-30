#!/usr/bin/env node
// Bundles cli.ts into dist/cli.js for npm distribution.
// All local TypeScript is bundled and types are stripped by esbuild.
// npm dependencies (esbuild, playwright-core, ws) remain external so they
// continue to be resolved from the consumer's node_modules at runtime.
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });

await build({
  entryPoints: ['cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/cli.js',
  external: ['esbuild', 'playwright-core', 'ws'],
  logLevel: 'warning',
});

console.log('Built dist/cli.js');
