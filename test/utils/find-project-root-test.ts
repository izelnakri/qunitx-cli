import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { module, test } from 'qunitx';
import { findProjectRoot, ProjectRootNotFound } from '../../lib/utils/find-project-root.ts';

// Every case here hands `findProjectRoot` the directory to search from, which is why the `cwd`
// parameter exists. These tests used to `process.chdir()` instead and restore it afterwards, safe
// because they run serially — but only within this file. `deno test --parallel` runs test modules
// as workers in ONE process, so the chdir moved the cwd of every other module running at the
// time, and any `node cli.ts` a concurrent test spawned inherited a temp directory with no
// package.json above it. That is CI run 35944599684: repl/cli-test.ts died on
// `ProjectRootNotFound: … /private/var/folders/…/T/<uuid>`, a path only this file builds.
module('Utils | findProjectRoot', { concurrency: true }, () => {
  test('resolves to the directory holding the nearest package.json', async (assert) => {
    const project = await makeProject();

    const root = await findProjectRoot(project).result();

    assert.false(ProjectRootNotFound.is(root));
    assert.true(await fileExists(path.join(root as string, 'package.json')));
  });

  test('walks up from a nested directory to the same root', async (assert) => {
    const project = await makeProject();
    const nested = path.join(project, 'src', 'deep');
    await fs.mkdir(nested, { recursive: true });

    const root = await findProjectRoot(nested).result();

    assert.equal(await realpath(root as string), await realpath(project));
  });

  // The parameter defaults to the working directory, which is what the CLI relies on. Asserting
  // it against the directory the suite already runs in needs no chdir: this repository has a
  // package.json, so the answer for its own cwd is its own root.
  test('searches the working directory when it is given nothing', async (assert) => {
    const root = await findProjectRoot().result();

    assert.equal(await realpath(root as string), await realpath(process.cwd()));
  });

  // Before this returned a declared failure it called process.exit(1) from inside a library
  // function, so there was no way to assert the miss — the assertion killed the test worker.
  test('a missing package.json is a declared failure, not a process exit', async (assert) => {
    const outcome = await findProjectRoot(await makeEmptyDir()).result();

    assert.true(ProjectRootNotFound.is(outcome));
  });

  test('the failure names the directory it searched from', async (assert) => {
    const dir = await makeEmptyDir();

    const failure = await findProjectRoot(dir).result();

    assert.equal(
      await realpath((failure as { data: { cwd: string } }).data.cwd),
      await realpath(dir),
    );
    assert.true((failure as { message: string }).message.includes('npm init'));
  });

  test('the caller decides — unwrapOr substitutes a root instead of exiting', async (assert) => {
    const root = await findProjectRoot(await makeEmptyDir()).unwrapOr('/fallback/root');

    assert.equal(root, '/fallback/root');
  });
});

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
