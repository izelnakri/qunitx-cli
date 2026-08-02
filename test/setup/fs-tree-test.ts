import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { module, test } from 'qunitx';
import * as FSTree from '../../lib/setup/fs-tree.ts';

module('Setup | FSTree.build | extensions', { concurrency: true }, () => {
  test('includes .js, .ts, .jsx, .tsx files by default (no config.extensions)', async (assert) => {
    const dir = await makeTempDir(['a.js', 'b.ts', 'c.css', 'd.mjs', 'e.jsx', 'f.tsx']);
    const fsTree = await FSTree.build([dir]);
    const names = Object.keys(fsTree).map((filePath) => path.basename(filePath));
    assert.true(names.includes('a.js'));
    assert.true(names.includes('b.ts'));
    assert.true(names.includes('e.jsx'));
    assert.true(names.includes('f.tsx'));
    assert.false(names.includes('c.css'));
    assert.false(names.includes('d.mjs'));
  });

  test('respects config.extensions — only tracks specified extensions', async (assert) => {
    const dir = await makeTempDir(['a.js', 'b.ts', 'c.mjs']);
    const fsTree = await FSTree.build([dir], { extensions: ['mjs'] });
    const names = Object.keys(fsTree).map((filePath) => path.basename(filePath));
    assert.false(names.includes('a.js'));
    assert.false(names.includes('b.ts'));
    assert.true(names.includes('c.mjs'));
  });

  test('config.extensions with multiple custom types', async (assert) => {
    const dir = await makeTempDir(['a.js', 'b.coffee', 'c.mjs', 'd.ts']);
    const fsTree = await FSTree.build([dir], { extensions: ['js', 'coffee'] });
    const names = Object.keys(fsTree).map((filePath) => path.basename(filePath));
    assert.true(names.includes('a.js'));
    assert.true(names.includes('b.coffee'));
    assert.false(names.includes('c.mjs'));
    assert.false(names.includes('d.ts'));
  });
});

module('Setup | FSTree.build | file input', { concurrency: true }, () => {
  test('a direct file path adds exactly that file', async (assert) => {
    const dir = await makeTempDir(['a.ts', 'b.ts']);
    const filePath = path.join(dir, 'a.ts');
    const fsTree = await FSTree.build([filePath]);
    assert.deepEqual(Object.keys(fsTree), [filePath]);
  });

  test('a direct file path is included regardless of config.extensions', async (assert) => {
    const dir = await makeTempDir(['a.css']);
    const filePath = path.join(dir, 'a.css');
    const fsTree = await FSTree.build([filePath], { extensions: ['ts'] });
    assert.deepEqual(Object.keys(fsTree), [filePath]);
  });
});

module('Setup | FSTree.build | symlinks', { concurrency: true }, () => {
  test('a symlink to a .ts file inside a directory is included in the tree', async (assert) => {
    // fs.readdir withFileTypes reports symlinks as isSymbolicLink(), not isFile().
    // Without explicit handling they would be silently excluded from the initial scan.
    const dir = await makeTempDirWithSymlinks(['real.ts'], { 'link.ts': 'real.ts' });
    const fsTree = await FSTree.build([dir]);
    const names = Object.keys(fsTree).map((filePath) => path.basename(filePath));
    assert.true(names.includes('real.ts'), 'real file included');
    assert.true(names.includes('link.ts'), 'symlink to .ts file included');
  });

  test('a symlink to a .js file is included when js is in extensions', async (assert) => {
    const dir = await makeTempDirWithSymlinks(['real.js'], { 'link.js': 'real.js' });
    const fsTree = await FSTree.build([dir]);
    const names = Object.keys(fsTree).map((filePath) => path.basename(filePath));
    assert.true(names.includes('link.js'));
  });

  test('a symlink to a file with non-matching extension is excluded', async (assert) => {
    const dir = await makeTempDirWithSymlinks(['real.css'], { 'link.css': 'real.css' });
    const fsTree = await FSTree.build([dir]);
    const names = Object.keys(fsTree).map((filePath) => path.basename(filePath));
    assert.false(names.includes('link.css'));
  });

  test('a dangling symlink (broken target) is excluded', async (assert) => {
    const dir = path.join(process.cwd(), 'tmp', crypto.randomUUID());
    await fs.mkdir(dir, { recursive: true });
    // Symlink points to a non-existent path — stat will fail.
    await fs.symlink(path.join(dir, 'nonexistent.ts'), path.join(dir, 'dangling.ts'));
    const fsTree = await FSTree.build([dir]);
    const names = Object.keys(fsTree).map((filePath) => path.basename(filePath));
    assert.false(names.includes('dangling.ts'), 'dangling symlink excluded');
  });

  test('a symlink to a directory is excluded even when it matches the extension filter', async (assert) => {
    // A symlink named 'subdir.ts' pointing to a directory is not a bundleable file.
    const dir = path.join(process.cwd(), 'tmp', crypto.randomUUID());
    const subdir = path.join(dir, 'real-subdir');
    await fs.mkdir(subdir, { recursive: true });
    await fs.writeFile(path.join(subdir, 'ignored.ts'), '');
    await fs.symlink(subdir, path.join(dir, 'subdir.ts')); // symlink to dir, confusingly named .ts
    const fsTree = await FSTree.build([dir]);
    const names = Object.keys(fsTree).map((filePath) => path.basename(filePath));
    assert.false(names.includes('subdir.ts'), 'symlink-to-dir excluded');
  });

  test('a symlink to a .ts file passed directly as a path is included', async (assert) => {
    // FSTree.build uses stat() for direct file paths which already follows symlinks.
    const dir = await makeTempDirWithSymlinks(['real.ts'], { 'link.ts': 'real.ts' });
    const linkPath = path.join(dir, 'link.ts');
    const fsTree = await FSTree.build([linkPath]);
    assert.deepEqual(Object.keys(fsTree), [linkPath]);
  });
});

module('Setup | FSTree.build | glob input', { concurrency: true }, () => {
  test('a glob pattern expands to matching files', async (assert) => {
    const dir = await makeTempDir(['a.ts', 'b.ts', 'c.js']);
    const fsTree = await FSTree.build([`${dir}/*.ts`]);
    const names = Object.keys(fsTree).map((filePath) => path.basename(filePath));
    assert.true(names.includes('a.ts'));
    assert.true(names.includes('b.ts'));
    assert.false(names.includes('c.js'));
  });

  test('a recursive glob pattern matches files in subdirectories', async (assert) => {
    const dir = await makeTempDir(['a.ts', 'sub/b.ts', 'sub/c.js']);
    const fsTree = await FSTree.build([`${dir}/**/*.ts`]);
    const names = Object.keys(fsTree).map((filePath) => path.basename(filePath));
    assert.true(names.includes('a.ts'));
    assert.true(names.includes('b.ts'));
    assert.false(names.includes('c.js'));
  });

  test('glob respects config.extensions filter', async (assert) => {
    const dir = await makeTempDir(['a.ts', 'b.js', 'c.css']);
    const fsTree = await FSTree.build([`${dir}/*`], { extensions: ['ts'] });
    const names = Object.keys(fsTree).map((filePath) => path.basename(filePath));
    assert.true(names.includes('a.ts'));
    assert.false(names.includes('b.js'));
    assert.false(names.includes('c.css'));
  });
});

// An unreadable input used to be `console.error(error); process.exit(1)` — inside a library
// function, so this whole module was unassertable: the first bad path killed the test worker.
module('Setup | FSTree.build | unreadable input', { concurrency: true }, () => {
  test('a missing path is a declared failure naming the input that failed', async (assert) => {
    const missing = path.join(process.cwd(), 'tmp', crypto.randomUUID(), 'nope.ts');

    const outcome = await FSTree.build([missing]).result();

    assert.true(FSTree.InputUnreadable.is(outcome));
    assert.equal((outcome as FSTree.InputUnreadableFailure).data.input, missing);
  });

  test('the underlying ENOENT is preserved under cause, not swallowed', async (assert) => {
    const missing = path.join(process.cwd(), 'tmp', crypto.randomUUID(), 'nope.ts');

    const failure = (await FSTree.build([missing]).result()) as FSTree.InputUnreadableFailure;

    assert.equal((failure.cause as NodeJS.ErrnoException).code, 'ENOENT');
  });

  test('one bad input fails the build without losing which of several it was', async (assert) => {
    const good = await makeTempDir(['a.ts']);
    const missing = path.join(good, 'does-not-exist', 'nope.ts');

    const failure = (await FSTree.build([good, missing]).result()) as FSTree.InputUnreadableFailure;

    assert.equal(failure.data.input, missing);
  });

  // Each input answers with its own files and the fold happens once, so nothing survives a call
  // — which is what makes a retried build safe: the second attempt cannot inherit entries the
  // first wrote before it failed (including files deleted in between).
  test('each build produces its own tree, sharing no state with the last', async (assert) => {
    const dir = await makeTempDir(['a.ts', 'b.ts']);

    const first = await FSTree.build([dir]);
    const second = await FSTree.build([dir]);

    assert.notStrictEqual(first, second, 'a fresh accumulator per build, not a module-level one');
    assert.deepEqual(Object.keys(first).sort(), Object.keys(second).sort());
  });

  test('a readable input still resolves to the tree, not a failure', async (assert) => {
    const dir = await makeTempDir(['a.ts']);

    const outcome = await FSTree.build([dir]).result();

    assert.false(FSTree.InputUnreadable.is(outcome));
    assert.equal(Object.keys(outcome as object).length, 1);
  });
});

async function makeTempDir(files: string[]): Promise<string> {
  const dir = path.join(process.cwd(), 'tmp', crypto.randomUUID());
  await Promise.all(
    files.map(async (filename) => {
      const filePath = path.join(dir, filename);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, '');
    }),
  );
  return dir;
}

// Creates a temp dir with real files plus optional symlinks.
// `symlinks` is a map of { linkName: targetName } where both are relative to the dir.
async function makeTempDirWithSymlinks(
  files: string[],
  symlinks: Record<string, string> = {},
): Promise<string> {
  const dir = await makeTempDir(files);
  await Promise.all(
    Object.entries(symlinks).map(([linkName, targetName]) =>
      fs.symlink(path.join(dir, targetName), path.join(dir, linkName)),
    ),
  );
  return dir;
}
