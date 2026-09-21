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
import { canUseSea } from './sea-support.js';

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
  if (!target || !canUseSea(process.cwd())) return false;
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
      // `spawn` is the only reliable line between "it ran and exited" and "it never started".
      // A binary whose ELF interpreter is missing — the shape of a SEA built on one distribution
      // and installed on another — fails inside `execve`, so BOTH `error` and `close` fire, and
      // `close` arrives with code -2.
      let started = false;
      const child = spawn(binaryPath, process.argv.slice(2), { stdio: 'inherit', env });
      child.on('spawn', () => {
        started = true;
      });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        // Without this guard the launcher killed its own fallback: `error` rejected and the JS
        // CLI began loading, then `close` called process.exit(-2) — which a shell reports as
        // 254, with no output at all. That was the whole of the bug report.
        if (!started) return;
        if (signal !== null) return void process.kill(process.pid, signal);

        process.exit(code ?? 1);
      });
    });
  } catch (error) {
    // Said once, on stderr, and only when a binary that IS installed cannot be started. A silent
    // fallback is correct but undiagnosable: the JS CLI works, so nothing looks wrong, and the
    // platform package stays broken for as long as nobody thinks to check it.
    if (error?.code === 'ENOENT' || error?.code === 'EACCES') {
      process.stderr.write(
        `# qunitx: the ${target.seaPkg} binary could not be started (${error.code}) — ` +
          'running the JavaScript CLI instead.\n' +
          '# That binary is built for this platform but not for this system; please report it.\n',
      );
    }

    return false;
  }
}

if (!(await trySeaBinary())) {
  // Fallback: run bundled JS CLI via Node.js (uses node_modules for deps)
  await import('../dist/cli.js');
}
