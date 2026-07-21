import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { rmRetry } from './helpers/rm-retry.ts';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { findSidecarEsbuild } from '../lib/utils/find-sidecar-esbuild.ts';
import { isDenoCompiledBinary } from '../lib/utils/run-user-module.ts';
import { readTemplate } from '../lib/utils/read-template.ts';
import './helpers/custom-asserts.ts';

const IS_DENO = typeof (globalThis as { Deno?: unknown }).Deno !== 'undefined';

// ─────────────────────────────────────────────────────────────────────────────
// Deno compatibility adjustments — single source of truth.
//
// Every workaround we carry purely for Deno (`deno run` and, mostly, the
// `deno compile` binary) is catalogued here with a *removal recipe*: delete the
// adjustment, run the listed check, and a green result means the workaround is now
// redundant (upstream Deno caught up) and can be dropped. Some adjustments are
// unit-tested directly in this file; others only manifest under the compiled
// binary or a specific OS and are verified by the existing feature tests running
// on the `test-deno` CI lane — those are indexed below, not duplicated.
//
// When bumping Deno, work down this list; each entry maps to its own cleanup commit.
//
//  1. esbuild sidecar hint — lib/utils/find-sidecar-esbuild.ts
//     Why: `deno compile` bundles JS but can't embed esbuild's native binary, so we
//     point ESBUILD_BINARY_PATH at a sidecar next to the exe. Check: the
//     "esbuild sidecar resolution" tests below + the deno release-consumer CI lane.
//
//  2. deno-compiled-binary detection + user-module bundling — lib/utils/run-user-module.ts
//     Why: the compiled binary's resolver can't see the user's node_modules and
//     rejects TS, so --before/--after/user modules are esbuild-bundled first.
//     Check: the "deno-compiled-binary detection" tests below cover the gate; the
//     bundling path itself is exercised by the --before/--after tests on test-deno.
//
//  3. template reads — lib/utils/read-template.ts  [RETIRED on Deno 2.9.2]
//     Was: node:fs.readFile rejected inside the deno-compile virtual FS, so we read
//     via Deno.readFile. Deno 2.9.2 reads `--include`d files through node:fs.readFile
//     (verified via `dist/qunitx init`/`generate`), so the branch was removed. Guard:
//     the release-consumer-test-deno CI lane runs template commands through the
//     compiled binary; the "template reading" tests below cover source / deno run.
//
//  4. asset copy — lib/setup/write-output-static-files.ts  [RETIRED on Deno 2.9.2]
//     Was: Deno.copyFile threw INVALID_HANDLE (os error 6) on the compiled Windows
//     binary for node_modules/.deno/* sources, so we buffered via read+write. A
//     windows-latest probe on 2.9.2 (Deno.copyFile of a node_modules/.deno path)
//     succeeded, so it's back to plain fs.copyFile.
//
//  5. rename-event dedupe (RENAME_DEDUPE_MS) — lib/setup/file-watcher.ts#15
//     Why: Deno's node:fs.watch fires duplicate 'rename' events under recursive
//     watching. Check: the rename tests in test/setup/file-watcher-test.ts on test-deno.
//
//  6. IS_DENO periodic rescan safety-net — lib/setup/file-watcher.ts#27,#305
//     Why: on Linux, Deno's recursive fs.watch silently drops symlink create/rename
//     events. Check: the 7 symlink tests in test/flags/watch-rerun-test.ts on the
//     Linux test-deno lane (delete the `|| IS_DENO` and they should still pass if fixed).
//
//  7. Windows firefox/webkit launch retry — lib/setup/browser.ts#97
//     Why: `deno compile`'s child_process.spawn throws "handle is invalid (os error 6)"
//     for Playwright's pipe-transport launch — denoland/deno#35994. Check: CI only; the
//     deno+Windows+Firefox combo is excluded from the release matrices. Remove the retry
//     (and re-add the matrix rows) once #35994 is fixed.
//
//  8. daemon tests skipped on deno-compile Windows — test/commands/daemon-test.ts
//     Why: `cli daemon start` hangs (suspected child_process detach + named-pipe).
//     STILL NEEDED on 2.9.2: a windows probe with the skip off hung the full daemon
//     suite past 25 min (a lone `daemon start` returns, but the suite does not).
//
//  9. stderr drain listener — test/helpers/shell.ts#252
//     Why: under Deno's node:child_process, .resume() doesn't pump the pipe, so a noisy
//     stderr back-pressures the writer and stalls tests. Check: remove the no-op
//     'data' listener and run the test-deno lane (watch/daemon tests stall if still needed).
// ─────────────────────────────────────────────────────────────────────────────

module('Deno compat | esbuild sidecar resolution (find-sidecar-esbuild.ts)', () => {
  async function stageExecutable(dir: string, name: string): Promise<void> {
    const file = path.join(dir, name);
    await fs.writeFile(file, '#!/bin/sh\n');
    await fs.chmod(file, 0o755);
  }

  test('finds an esbuild sidecar next to the exec dir', async (assert) => {
    const dir = path.join(os.tmpdir(), `qunitx-sidecar-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    try {
      await stageExecutable(dir, 'esbuild');
      assert.equal(findSidecarEsbuild(dir, 'linux'), path.join(dir, 'esbuild'));
    } finally {
      await rmRetry(dir);
    }
  });

  test('prefers esbuild.exe over esbuild on win32', async (assert) => {
    const dir = path.join(os.tmpdir(), `qunitx-sidecar-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    try {
      await stageExecutable(dir, 'esbuild');
      await stageExecutable(dir, 'esbuild.exe');
      assert.equal(findSidecarEsbuild(dir, 'win32'), path.join(dir, 'esbuild.exe'));
    } finally {
      await rmRetry(dir);
    }
  });

  test('returns null when no sidecar is present', async (assert) => {
    const dir = path.join(os.tmpdir(), `qunitx-sidecar-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    try {
      assert.equal(findSidecarEsbuild(dir, 'linux'), null);
    } finally {
      await rmRetry(dir);
    }
  });
});

module('Deno compat | deno-compiled-binary detection (run-user-module.ts)', () => {
  test('false under Node (no global Deno)', (assert) => {
    assert.false(isDenoCompiledBinary(false, '/usr/local/bin/node'));
  });

  test('false under `deno run` — execPath ends with deno / deno.exe', (assert) => {
    assert.false(isDenoCompiledBinary(true, '/usr/local/bin/deno'));
    assert.false(isDenoCompiledBinary(true, 'C:\\Program Files\\deno\\deno.exe'));
  });

  test('true inside a deno compile binary — execPath is the user binary', (assert) => {
    assert.true(isDenoCompiledBinary(true, '/home/me/dist/qunitx'));
    assert.true(isDenoCompiledBinary(true, 'C:\\Users\\me\\.qunitx\\qunitx.exe'));
  });

  test('default call reflects the current runtime (never a compiled binary in tests)', (assert) => {
    // Under both `node --test` and `deno test`, this must be false — the suite never
    // runs inside a compiled binary. If it ever returns true here the detection broke.
    assert.false(isDenoCompiledBinary());
  });
});

module('Deno compat | template reading (read-template.ts)', () => {
  test('reads a flat template', async (assert) => {
    const content = await readTemplate('test.js');
    assert.includes(content, "import { module, test } from 'qunitx'");
  });

  test('reads a nested template (subdir path)', async (assert) => {
    const content = await readTemplate('setup/tsconfig.json');
    assert.includes(content, 'compilerOptions');
  });

  test('throws a helpful error for a missing template', async (assert) => {
    await assert.rejects(readTemplate('does-not-exist.txt'), /not found/);
  });
});

// Gated to Deno — this is the runtime the workaround exists for. Under Node, the
// pipe is pumped automatically so the scenario can't fail; under Deno's
// node:child_process a child that floods stderr back-pressures and blocks before it
// can write stdout unless the parent drains stderr. Redundancy check: delete the
// `child.stderr.on('data', () => {})` drains in test/helpers/shell.ts#252 and the
// spawnWatch helper, run this under the Deno lane — if it still passes, Deno now
// pumps the pipe and the drains can go.
module('Deno compat | child_process stderr must be drained (shell.ts)', () => {
  test('a stderr flood does not stall stdout delivery when drained', async (assert) => {
    if (!IS_DENO) {
      assert.ok(true, 'skipped under Node — the OS pipe is pumped without an explicit drain');
      return;
    }
    const dir = path.join(os.tmpdir(), `qunitx-stderr-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const script = path.join(dir, 'flood.mjs');
    // ~512 KB to stderr (>> the ~64 KB pipe buffer) BEFORE the stdout marker, so an
    // undrained stderr provably blocks the child before "READY" is ever written.
    await fs.writeFile(
      script,
      `const b='x'.repeat(1024);for(let i=0;i<512;i++)process.stderr.write(b);process.stdout.write('READY\\n');`,
    );
    try {
      // process.execPath is the deno binary here, so it needs the `run` subcommand.
      const child = spawn(process.execPath, ['run', '-A', script]);
      const got = await new Promise<string>((resolve, reject) => {
        let out = '';
        const timer = setTimeout(
          () => reject(new Error(`stalled — stdout was: ${out.trim()}`)),
          5000,
        );
        child.stdout.on('data', (chunk) => {
          out += chunk.toString();
          if (out.includes('READY')) {
            clearTimeout(timer);
            resolve(out);
          }
        });
        child.stderr.on('data', () => {}); // the drain under test
        child.on('error', reject);
      });
      child.kill();
      assert.true(got.includes('READY'), 'stdout marker arrived past the stderr flood');
    } finally {
      await rmRetry(dir);
    }
  });
});
