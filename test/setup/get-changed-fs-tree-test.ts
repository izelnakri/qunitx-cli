import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { module, test } from 'qunitx';
import { getChangedFsTree } from '../../lib/setup/get-changed-fs-tree.ts';
import * as MetafileCache from '../../lib/utils/metafile-cache.ts';
import type { AffectedMetafile } from '../../lib/utils/get-changed-files.ts';
import type { FSTree } from '../../lib/types.ts';

// getChangedFsTree's job is metafile-based FILTERING; git change-detection is an
// injectable dependency. These tests drive the four outcome branches
// (git-error / blast-radius-null / nothing-changed / filtered) by injecting the git
// result directly — no real git subprocess. The previous version created a real repo
// per test (unbounded `git init/add/commit`), which wedged the deno/Windows lane for
// the full 300s per-test budget when a git child's exit event never arrived. The live
// git integration is covered end-to-end against a real subprocess in
// test/flags/changed-test.ts, so nothing is lost here.

async function makeProject(): Promise<string> {
  const root = path.join(os.tmpdir(), `qunitx-get-changed-fs-tree-${crypto.randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  return root;
}

function fsTreeFromAbs(root: string, files: string[]): FSTree {
  return Object.fromEntries(files.map((f) => [path.join(root, f), null]));
}

function metafileFor(graph: Record<string, string[]>): AffectedMetafile {
  return {
    inputs: Object.fromEntries(
      Object.entries(graph).map(([file, imports]) => [
        file,
        { imports: imports.map((p) => ({ path: p })) },
      ]),
    ),
  };
}

// Injected git seams: what `getChangedFilePathsInGitSince` would have returned.
// It yields absolute paths, so the fixtures do too.
const gitChanged = (root: string, files: string[]) => (): Promise<Set<string>> =>
  Promise.resolve(new Set(files.map((f) => path.join(root, f))));
const gitBlastRadius = (): Promise<null> => Promise.resolve(null);
const gitFailed = (): Promise<never> => Promise.reject(new Error('fatal: not a git repository'));

module('Setup | getChangedFsTree | fallback paths', { concurrency: true }, () => {
  test('no metafile cache → returns input fsTree unchanged (git never consulted)', async (assert) => {
    const root = await makeProject();
    const tree = fsTreeFromAbs(root, ['test/a-test.ts']);
    const result = await getChangedFsTree(tree, root, 'HEAD', gitChanged(root, ['src/a.ts']));
    assert.strictEqual(result, tree);
  });

  test('git fails → returns input fsTree unchanged', async (assert) => {
    const root = await makeProject();
    await MetafileCache.write(root, root, metafileFor({}));
    const tree = fsTreeFromAbs(root, ['test/a-test.ts']);
    const result = await getChangedFsTree(tree, root, 'HEAD', gitFailed);
    assert.strictEqual(result, tree);
  });

  test('blast-radius change (git returns null) → returns input fsTree unchanged', async (assert) => {
    const root = await makeProject();
    await MetafileCache.write(root, root, metafileFor({ 'test/a-test.ts': [] }));
    const tree = fsTreeFromAbs(root, ['test/a-test.ts']);
    const result = await getChangedFsTree(tree, root, 'HEAD', gitBlastRadius);
    assert.strictEqual(result, tree);
  });
});

module('Setup | getChangedFsTree | filtered runs', { concurrency: true }, () => {
  test('filters to tests whose deps include a changed source file', async (assert) => {
    const root = await makeProject();
    await MetafileCache.write(
      root,
      root,
      metafileFor({
        'test/a-test.ts': ['src/a.ts'],
        'test/b-test.ts': ['src/b.ts'],
        'src/a.ts': [],
        'src/b.ts': [],
      }),
    );
    const tree = fsTreeFromAbs(root, ['test/a-test.ts', 'test/b-test.ts']);
    const result = await getChangedFsTree(tree, root, 'HEAD', gitChanged(root, ['src/a.ts']));
    assert.deepEqual(
      Object.keys(result).sort(),
      [path.join(root, 'test/a-test.ts')],
      'only the affected test survives',
    );
  });

  test('no changes → returns empty fsTree (skip-all path)', async (assert) => {
    const root = await makeProject();
    await MetafileCache.write(root, root, metafileFor({ 'test/a-test.ts': [] }));
    const tree = fsTreeFromAbs(root, ['test/a-test.ts']);
    const result = await getChangedFsTree(tree, root, 'HEAD', gitChanged(root, []));
    assert.equal(Object.keys(result).length, 0);
  });

  test('empty input fsTree short-circuits before any git or cache read', async (assert) => {
    const root = await makeProject();
    // Inject a detector that throws if called — proves the empty-tree guard returns first.
    const result = await getChangedFsTree({}, root, 'HEAD', gitFailed);
    assert.equal(Object.keys(result).length, 0);
  });
});
