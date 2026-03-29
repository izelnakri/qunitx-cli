import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { module, test } from 'qunitx';
import buildFSTree from '../../lib/setup/fs-tree.ts';

async function makeTempDir(files: string[]): Promise<string> {
  const dir = path.join(process.cwd(), 'tmp', crypto.randomUUID());
  await Promise.all(
    files.map(async (f) => {
      const filePath = path.join(dir, f);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, '');
    }),
  );
  return dir;
}

module('Setup | buildFSTree | extensions', () => {
  test('includes .js and .ts files by default (no config.extensions)', async (assert) => {
    const dir = await makeTempDir(['a.js', 'b.ts', 'c.css', 'd.mjs']);
    const fsTree = await buildFSTree([dir]);
    const names = Object.keys(fsTree).map((p) => path.basename(p));
    assert.true(names.includes('a.js'));
    assert.true(names.includes('b.ts'));
    assert.false(names.includes('c.css'));
    assert.false(names.includes('d.mjs'));
  });

  test('respects config.extensions — only tracks specified extensions', async (assert) => {
    const dir = await makeTempDir(['a.js', 'b.ts', 'c.mjs']);
    const fsTree = await buildFSTree([dir], { extensions: ['mjs'] });
    const names = Object.keys(fsTree).map((p) => path.basename(p));
    assert.false(names.includes('a.js'));
    assert.false(names.includes('b.ts'));
    assert.true(names.includes('c.mjs'));
  });

  test('config.extensions with multiple custom types', async (assert) => {
    const dir = await makeTempDir(['a.js', 'b.coffee', 'c.mjs', 'd.ts']);
    const fsTree = await buildFSTree([dir], { extensions: ['js', 'coffee'] });
    const names = Object.keys(fsTree).map((p) => path.basename(p));
    assert.true(names.includes('a.js'));
    assert.true(names.includes('b.coffee'));
    assert.false(names.includes('c.mjs'));
    assert.false(names.includes('d.ts'));
  });
});

module('Setup | buildFSTree | file input', () => {
  test('a direct file path adds exactly that file', async (assert) => {
    const dir = await makeTempDir(['a.ts', 'b.ts']);
    const filePath = path.join(dir, 'a.ts');
    const fsTree = await buildFSTree([filePath]);
    assert.deepEqual(Object.keys(fsTree), [filePath]);
  });

  test('a direct file path is included regardless of config.extensions', async (assert) => {
    const dir = await makeTempDir(['a.css']);
    const filePath = path.join(dir, 'a.css');
    const fsTree = await buildFSTree([filePath], { extensions: ['ts'] });
    assert.deepEqual(Object.keys(fsTree), [filePath]);
  });
});

module('Setup | buildFSTree | glob input', () => {
  test('a glob pattern expands to matching files', async (assert) => {
    const dir = await makeTempDir(['a.ts', 'b.ts', 'c.js']);
    const fsTree = await buildFSTree([`${dir}/*.ts`]);
    const names = Object.keys(fsTree).map((p) => path.basename(p));
    assert.true(names.includes('a.ts'));
    assert.true(names.includes('b.ts'));
    assert.false(names.includes('c.js'));
  });

  test('a recursive glob pattern matches files in subdirectories', async (assert) => {
    const dir = await makeTempDir(['a.ts', 'sub/b.ts', 'sub/c.js']);
    const fsTree = await buildFSTree([`${dir}/**/*.ts`]);
    const names = Object.keys(fsTree).map((p) => path.basename(p));
    assert.true(names.includes('a.ts'));
    assert.true(names.includes('b.ts'));
    assert.false(names.includes('c.js'));
  });

  test('glob respects config.extensions filter', async (assert) => {
    const dir = await makeTempDir(['a.ts', 'b.js', 'c.css']);
    const fsTree = await buildFSTree([`${dir}/*`], { extensions: ['ts'] });
    const names = Object.keys(fsTree).map((p) => path.basename(p));
    assert.true(names.includes('a.ts'));
    assert.false(names.includes('b.js'));
    assert.false(names.includes('c.css'));
  });
});
