#!/usr/bin/env node
// npm bin entry for qunitx-cli.
// Prefers a pre-built SEA binary from the matching optional platform package
// (qunitx-cli-linux-x64, qunitx-cli-darwin-arm64, etc.) when available.
// Falls back to the bundled JS CLI (dist/cli.js) which requires Node.js + node_modules.
import nodeModule, { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { access, constants, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Turn on V8's on-disk compile cache before importing dist/cli.js — caches
// the bundle + its external deps (esbuild, playwright-core, ws) across cold
// invocations. The active dir is written back to process.env so any child
// spawn (SEA binary below, daemon auto-spawn from cli.ts) inherits and also
// auto-enables from boot. `in` check preserves a user-set empty string.
const cacheResult = nodeModule.enableCompileCache?.();
if (cacheResult?.directory && !('NODE_COMPILE_CACHE' in process.env)) {
  process.env.NODE_COMPILE_CACHE = cacheResult.directory;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const currentVersion = JSON.parse(
  await readFile(join(__dirname, '../package.json'), 'utf8'),
).version;

const platformMap = {
  'linux-x64': { seaPkg: 'qunitx-cli-linux-x64', esbuildPkg: '@esbuild/linux-x64', bin: 'qunitx' },
  'linux-arm64': {
    seaPkg: 'qunitx-cli-linux-arm64',
    esbuildPkg: '@esbuild/linux-arm64',
    bin: 'qunitx',
  },
  'darwin-x64': {
    seaPkg: 'qunitx-cli-darwin-x64',
    esbuildPkg: '@esbuild/darwin-x64',
    bin: 'qunitx',
  },
  'darwin-arm64': {
    seaPkg: 'qunitx-cli-darwin-arm64',
    esbuildPkg: '@esbuild/darwin-arm64',
    bin: 'qunitx',
  },
  'win32-x64': {
    seaPkg: 'qunitx-cli-windows-x64',
    esbuildPkg: '@esbuild/win32-x64',
    bin: 'qunitx.exe',
  },
};

const target = platformMap[`${process.platform}-${process.arch}`];

async function trySeaBinary() {
  if (!target) return false;
  try {
    const pkgJsonPath = require.resolve(`${target.seaPkg}/package.json`);
    const seaVersion = JSON.parse(await readFile(pkgJsonPath, 'utf8')).version;
    if (seaVersion !== currentVersion) return false;
    const pkgDir = dirname(pkgJsonPath);
    const binaryPath = join(pkgDir, 'bin', target.bin);
    await access(binaryPath, constants.X_OK);

    let env = process.env;
    if (!env.ESBUILD_BINARY_PATH) {
      try {
        const esbuildBin = require.resolve(
          `${target.esbuildPkg}/bin/esbuild${process.platform === 'win32' ? '.exe' : ''}`,
        );
        env = { ...env, ESBUILD_BINARY_PATH: esbuildBin };
      } catch (_e) {
        // esbuild binary not found in optional package — env stays as-is
      }
    }

    await new Promise((_resolve, reject) => {
      const child = spawn(binaryPath, process.argv.slice(2), { stdio: 'inherit', env });
      child.on('close', (code) => process.exit(code ?? 1));
      child.on('error', reject);
    });
  } catch (_) {
    return false;
  }
}

if (!(await trySeaBinary())) {
  // Fallback: run bundled JS CLI via Node.js (uses node_modules for deps)
  await import('../dist/cli.js');
}
