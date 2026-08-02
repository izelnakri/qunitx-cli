import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmRetry } from './rm-retry.ts';

// Temp directories that remove themselves when the scope ends.
//
//   await using output = outputDir('cov-exclude');
//
//   await shell(`node cli.ts … --output=${output}`, metadata);
//   assert.notOk((await fs.readFile(`${output}/coverage/lcov.info`, 'utf8')).includes('…'));
//
// One line, and the removal can no longer be forgotten or stranded by an early `return`. A
// failing assertion still cleans up, which is the case that matters: a leaked tmp dir does not
// fail its own test, it fails a later one.
//
// For a directory this cannot make for you — `mkdtemp`, a path derived from a config, a fixture
// project — register the cleanup on a stack instead, which takes any callback:
//
//   await using stack = new AsyncDisposableStack();
//   stack.defer(() => rmRetry(dir));

/**
 * A temp directory that removes itself at the end of the scope that `await using`s it.
 *
 * `toString` returns the path, so `${dir}` interpolates exactly like the plain string this
 * replaced. Passing it where a real `string` is required — `path.join(dir, …)` — is a type
 * error, and throws immediately and by name if the types are not being checked.
 */
class TempDirectory {
  readonly path: string;

  constructor(dirPath: string) {
    this.path = dirPath;
  }

  toString(): string {
    return this.path;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await rmRetry(this.path);
  }
}

/**
 * A unique path under the project's `tmp/`, removed when the scope ends.
 *
 * The directory is NOT created — this is for paths the CLI makes for itself, like `--output`.
 *
 * ```ts
 * import { outputDir } from './temp-dir.ts';
 *
 * // Defined, not invoked: the removal happens when the scope ends.
 * async function scoped() {
 *   await using output = outputDir('demo');
 *   return `${output}`; // 'tmp/demo-3f2b…'
 * }
 * ```
 */
export function outputDir(label: string): TempDirectory {
  return new TempDirectory(`tmp/${label}-${randomUUID()}`);
}

/**
 * A unique directory under `os.tmpdir()`, created before it is handed back and removed when the
 * scope ends.
 *
 * `os.tmpdir()` rather than the project's `tmp/` for anything a test needs OUTSIDE the
 * repository — a fixture project, an exec dir, a path with no package.json above it.
 *
 * ```ts
 * import { tempDir } from './temp-dir.ts';
 *
 * // Defined, not invoked: creates and later removes a real directory.
 * async function scoped() {
 *   await using dir = await tempDir('sidecar');
 *   return dir.path; // '/tmp/qunitx-sidecar-3f2b…'
 * }
 * ```
 */
export async function tempDir(label: string): Promise<TempDirectory> {
  const dirPath = path.join(os.tmpdir(), `qunitx-${label}-${randomUUID()}`);
  await fs.mkdir(dirPath, { recursive: true });

  return new TempDirectory(dirPath);
}
