import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { module, test } from 'qunitx';
import { getChangedFsTree } from '../../lib/setup/get-changed-fs-tree.ts';
import * as MetafileCache from '../../lib/utils/metafile-cache.ts';
import type { AffectedMetafile } from '../../lib/utils/get-changed-files.ts';
import type { FSTree } from '../../lib/types.ts';

// Asserts on the orchestrator's return value only. The stdout diagnostic
// ("# --changed: …") is covered end-to-end in test/flags/changed-test.ts
// against a real subprocess; monkey-patching process.stdout here would race
// when modules run with `concurrency: true`. Real git repos + real metafile
// cache are used because each fixture costs ~80 ms and any mock would lose
// fidelity for less.

const execFileAsync = promisify(execFile);

async function makeProjectWithGit(initial: Record<string, string>): Promise<string> {
  const root = path.join(process.cwd(), 'tmp', `get-changed-fs-tree-${crypto.randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  // node_modules holds the metafile cache — gitignore it so writes there don't
  // surface as "changed" in git status during the test. Fanned out in parallel
  // with the fixture writes since none of them depend on each other.
  await Promise.all([
    fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n'),
    ...Object.entries(initial).map(async ([rel, content]) => {
      const target = path.join(root, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }),
  ]);
  // Inline `-c` user info on commit — avoids touching `.git/config` and the
  // lock-file race two parallel `git config` calls would hit.
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await execFileAsync('git', ['add', '-A'], { cwd: root });
  await execFileAsync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'init'],
    { cwd: root },
  );
  return root;
}

// For "git fails" tests we need a directory that ISN'T under any git repo. The
// repo's tmp/ is inside qunitx-cli's own git work-tree, so git would find that
// parent repo via the upward walk; using os.tmpdir() (typically /tmp) escapes.
async function makeProjectWithoutGit(): Promise<string> {
  const root = path.join(os.tmpdir(), `qunitx-get-changed-fs-tree-no-git-${crypto.randomUUID()}`);
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

module('Setup | getChangedFsTree | fallback paths', { concurrency: true }, () => {
  test('no metafile cache → returns input fsTree unchanged', async (assert) => {
    const root = await makeProjectWithGit({ 'a.ts': '', 'test/a-test.ts': '' });
    const tree = fsTreeFromAbs(root, ['test/a-test.ts']);
    const result = await getChangedFsTree(tree, root, 'HEAD');
    assert.strictEqual(result, tree);
  });

  test('git fails (not a repo) → returns input fsTree unchanged', async (assert) => {
    const root = await makeProjectWithoutGit();
    await MetafileCache.write(root, root, metafileFor({}));
    const tree = fsTreeFromAbs(root, ['test/a-test.ts']);
    const result = await getChangedFsTree(tree, root, 'HEAD');
    assert.strictEqual(result, tree);
  });

  test('blast-radius file changed → returns input fsTree unchanged', async (assert) => {
    const root = await makeProjectWithGit({
      'package.json': '{}',
      'test/a-test.ts': '',
    });
    await MetafileCache.write(root, root, metafileFor({ 'test/a-test.ts': [] }));
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"x"}');
    const tree = fsTreeFromAbs(root, ['test/a-test.ts']);
    const result = await getChangedFsTree(tree, root, 'HEAD');
    assert.strictEqual(result, tree);
  });
});

module('Setup | getChangedFsTree | filtered runs', { concurrency: true }, () => {
  test('filters to tests whose deps include a changed source file', async (assert) => {
    const root = await makeProjectWithGit({
      'src/a.ts': 'export const a = 1;',
      'src/b.ts': 'export const b = 2;',
      'test/a-test.ts': "import './a.ts';",
      'test/b-test.ts': "import './b.ts';",
    });
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
    await fs.writeFile(path.join(root, 'src/a.ts'), 'export const a = 99;');
    const tree = fsTreeFromAbs(root, ['test/a-test.ts', 'test/b-test.ts']);
    const result = await getChangedFsTree(tree, root, 'HEAD');
    assert.deepEqual(
      Object.keys(result).sort(),
      [path.join(root, 'test/a-test.ts')],
      'only the affected test survives',
    );
  });

  test('no changes → returns empty fsTree (skip-all path)', async (assert) => {
    const root = await makeProjectWithGit({ 'test/a-test.ts': '' });
    await MetafileCache.write(root, root, metafileFor({ 'test/a-test.ts': [] }));
    const tree = fsTreeFromAbs(root, ['test/a-test.ts']);
    const result = await getChangedFsTree(tree, root, 'HEAD');
    assert.equal(Object.keys(result).length, 0);
  });

  test('empty input fsTree short-circuits without git or cache reads', async (assert) => {
    // Non-git dir + no metafile cache — any read would observably fail.
    const root = await makeProjectWithoutGit();
    const result = await getChangedFsTree({}, root, 'HEAD');
    assert.equal(Object.keys(result).length, 0);
  });
});
