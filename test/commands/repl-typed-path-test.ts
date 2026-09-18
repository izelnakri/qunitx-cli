import fs from 'node:fs/promises';
import path from 'node:path';
import { module, test } from 'qunitx';
import { findPath, pathAndDepth } from '../../lib/commands/repl/typed-path.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';

/** A directory with something in it, since every question here is about a real filesystem. */
async function sample(name: string) {
  const directory = await tempDir(name);
  await fs.mkdir(path.join(directory.path, 'repl'));
  await fs.mkdir(path.join(directory.path, 'reports'));
  await fs.writeFile(
    path.join(directory.path, 'index.ts'),
    "const a = 'one';\nexport default a;\n",
  );
  await fs.writeFile(path.join(directory.path, 'notes.md'), '# heading\nconst is not code here\n');
  await fs.writeFile(path.join(directory.path, '.hidden'), 'secret\n');

  return directory;
}

// `-L 2` the way `tree` takes it, and the path is whatever is left over.
module('Commands | repl | pathAndDepth', { concurrency: true }, () => {
  test('a depth flag anywhere, and the rest is where', (assert) => {
    assert.deepEqual(pathAndDepth('-L 2 lib'), { file: 'lib', depth: 2 });
    assert.deepEqual(pathAndDepth('lib -L 2'), { file: 'lib', depth: 2 }, 'in either order');
    assert.deepEqual(pathAndDepth('-L2 lib'), { file: 'lib', depth: 2 }, 'and either spelling');
  });

  test('no flag is all the way down, and no path is here', (assert) => {
    assert.deepEqual(pathAndDepth('lib'), { file: 'lib', depth: Infinity });
    assert.deepEqual(pathAndDepth(''), { file: '.', depth: Infinity });
    assert.deepEqual(pathAndDepth('-L 3'), { file: '.', depth: 3 }, 'a depth on its own');
  });
});

// Everything that is not a file says what it is instead, and hands back the part that was real.
module('Commands | repl | findPath', { concurrency: true }, () => {
  test('a file comes back with its contents', async (assert) => {
    await using directory = await sample('files-read');
    const found = findPath('index.ts', directory.path);

    assert.strictEqual(found.kind, 'file');
    assert.includes(found.kind === 'file' ? found.contents : '', "const a = 'one'");
  });

  test('a directory says so, and offers itself with a slash', async (assert) => {
    await using directory = await sample('files-directory');
    const found = findPath('repl', directory.path);

    assert.strictEqual(found.kind, 'directory');
    assert.strictEqual(found.kind === 'directory' ? found.prefill : '', 'repl/', 'ready to go on');
  });

  test('a path that goes wrong keeps the part that was right', async (assert) => {
    // What makes the second attempt a few keystrokes rather than the whole path again.
    await using directory = await sample('files-missing');

    const deep = findPath('repl/nowhere.ts', directory.path);
    assert.strictEqual(deep.kind, 'missing');
    assert.strictEqual(deep.kind === 'missing' ? deep.prefill : '', 'repl/');

    const shallow = findPath('nowhere.ts', directory.path);
    assert.strictEqual(
      shallow.kind === 'missing' ? shallow.prefill : 'x',
      '',
      'and offers nothing back when none of it was real',
    );
  });
});
