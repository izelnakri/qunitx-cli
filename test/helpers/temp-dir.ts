import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmRetry } from './rm-retry.ts';

// Temp directories that remove themselves when the scope ends.
//
//   await using stack = new AsyncDisposableStack();
//   const output = outputDir(stack, 'cov-exclude');
//
//   await shell(`node cli.ts … --output=${output}`, metadata);
//   assert.notOk((await fs.readFile(`${output}/coverage/lcov.info`, 'utf8')).includes('…'));
//
// `stack.adopt` hands the value straight back, so `output` is an ordinary string and every use
// of it reads exactly as it did — the whole change is that the `try`/`finally` around the body
// disappears along with the indent level it cost, and the removal can no longer be forgotten or
// stranded by an early `return`. A failing assertion still cleans up, which is the case that
// matters: a leaked tmp dir does not fail its own test, it fails a later one.

/**
 * A unique path under the project's `tmp/`, removed when `stack` disposes.
 *
 * The directory is NOT created — this is for paths the CLI makes for itself, like `--output`.
 *
 * ```ts
 * import { outputDir } from './temp-dir.ts';
 *
 * // Defined, not invoked: the removal happens when the scope ends.
 * async function scoped() {
 *   await using stack = new AsyncDisposableStack();
 *   return outputDir(stack, 'demo'); // 'tmp/demo-3f2b…'
 * }
 * ```
 */
export function outputDir(stack: AsyncDisposableStack, label: string): string {
  return stack.adopt(`tmp/${label}-${randomUUID()}`, rmRetry);
}

/**
 * A unique directory under `os.tmpdir()`, created before it is handed back and removed when
 * `stack` disposes.
 *
 * `os.tmpdir()` rather than the project's `tmp/` for anything a test needs OUTSIDE the
 * repository — a fixture project, an exec dir, a path with no package.json above it.
 *
 * ```ts
 * import { tempDir } from './temp-dir.ts';
 *
 * // Defined, not invoked: creates and later removes a real directory.
 * async function scoped() {
 *   await using stack = new AsyncDisposableStack();
 *   return await tempDir(stack, 'sidecar'); // '/tmp/qunitx-sidecar-3f2b…'
 * }
 * ```
 */
export async function tempDir(stack: AsyncDisposableStack, label: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `qunitx-${label}-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });

  return stack.adopt(dir, rmRetry);
}
