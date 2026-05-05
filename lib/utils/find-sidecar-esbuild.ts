// Side-effect module: finds an esbuild executable adjacent to the running binary
// and writes it into `process.env.ESBUILD_BINARY_PATH` when not already set.
//
// Required for the Deno-compiled binary: deno compile bundles the JS module graph
// but cannot embed the platform-native esbuild executable. Without this hint,
// esbuild's `ensureServiceIsRunning` tries to spawn the service from the path it
// discovered at install time — that path doesn't exist in the compiled-binary VFS
// and the spawn crashes inside Deno's child_process compat layer.
//
// Lookup order (first hit wins, all skipped if the env is already set — including
// to an empty string by a user who explicitly wants the install-time default):
//   1. <execDir>/esbuild        (drop-in alongside the qunitx binary)
//   2. <execDir>/esbuild.exe    (Windows variant)
//
// The Node SEA bundle has its own equivalent inline in the Makefile's PREAMBLE;
// this module is the Deno equivalent and is also harmless in plain Node (skipped
// because the env is already populated by `bin/qunitx.js` in that path).

import { accessSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';

if (!('ESBUILD_BINARY_PATH' in process.env)) {
  const execDir = dirname(process.execPath);
  const candidates = process.platform === 'win32' ? ['esbuild.exe', 'esbuild'] : ['esbuild'];
  for (const name of candidates) {
    const candidate = join(execDir, name);
    try {
      accessSync(candidate, constants.X_OK);
      process.env.ESBUILD_BINARY_PATH = candidate;
      break;
    } catch {
      /* not present — try next */
    }
  }
}
