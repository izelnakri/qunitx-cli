import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { module, test } from 'qunitx';
import buildFSTree from '../../lib/setup/fs-tree.ts';

async function makeTempDir(files) {
  const dir = path.join(process.cwd(), 'tmp', crypto.randomUUID());
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(files.map((f) => fs.writeFile(path.join(dir, f), '')));
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
