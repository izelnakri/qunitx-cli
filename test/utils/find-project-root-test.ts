import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { module, test } from 'qunitx';
import { findProjectRoot, ProjectRootNotFound } from '../../lib/utils/find-project-root.ts';

// findProjectRoot resolves against process.cwd(), so every test here restores it. The tests are
// serial for that reason — a concurrent chdir would be read by the wrong test.
module('Utils | findProjectRoot', () => {
  test('resolves to the directory holding the nearest package.json', async (assert) => {
    const root = await withCwd(await makeProject(), () => findProjectRoot().result());

    assert.false(ProjectRootNotFound.is(root));
    assert.true(await fileExists(path.join(root as string, 'package.json')));
  });

  test('walks up from a nested directory to the same root', async (assert) => {
    const project = await makeProject();
    const nested = path.join(project, 'src', 'deep');
    await fs.mkdir(nested, { recursive: true });

    const root = await withCwd(nested, () => findProjectRoot().result());

    assert.equal(await realpath(root as string), await realpath(project));
  });

  // Before this returned a declared failure it called process.exit(1) from inside a library
  // function, so there was no way to assert the miss — the assertion killed the test worker.
  test('a missing package.json is a declared failure, not a process exit', async (assert) => {
    const outcome = await withCwd(await makeEmptyDir(), () => findProjectRoot().result());

    assert.true(ProjectRootNotFound.is(outcome));
  });

  test('the failure names the directory it searched from', async (assert) => {
    const dir = await makeEmptyDir();

    const failure = await withCwd(dir, () => findProjectRoot().result());

    assert.equal(
      await realpath((failure as { data: { cwd: string } }).data.cwd),
      await realpath(dir),
    );
    assert.true((failure as { message: string }).message.includes('npm init'));
  });

  test('the caller decides — unwrapOr substitutes a root instead of exiting', async (assert) => {
    const root = await withCwd(await makeEmptyDir(), () =>
      findProjectRoot().unwrapOr('/fallback/root'),
    );

    assert.equal(root, '/fallback/root');
  });
});

async function withCwd<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

// A directory with no package.json at any level: os.tmpdir()'s ancestors have none, but this
// repository's do, so the temp root is the only place the miss can be observed. os.tmpdir()
// rather than a hardcoded '/tmp' — on Windows that resolves to a non-existent D:\tmp.
async function makeEmptyDir(): Promise<string> {
  const dir = path.join(await fs.realpath(os.tmpdir()), crypto.randomUUID());
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function makeProject(): Promise<string> {
  const dir = await makeEmptyDir();
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture' }));
  return dir;
}

async function fileExists(target: string): Promise<boolean> {
  return await fs.access(target).then(
    () => true,
    () => false,
  );
}

async function realpath(target: string): Promise<string> {
  return await fs.realpath(target);
}
