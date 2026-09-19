import fs from 'node:fs/promises';
import path from 'node:path';
import { module, test } from 'qunitx';
import { findPath, getPathAndDepth } from '../../lib/commands/repl/path-argument.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';
// `-L 2` the way `tree` takes it, and the path is whatever is left over.

module('Commands | repl | getPathAndDepth', { concurrency: true }, () => {
  test('a depth flag anywhere, and the rest is where', (assert) => {
    assert.deepEqual(getPathAndDepth('-L 2 lib'), { file: 'lib', depth: 2 });
    assert.deepEqual(getPathAndDepth('lib -L 2'), { file: 'lib', depth: 2 }, 'in either order');
    assert.deepEqual(getPathAndDepth('-L2 lib'), { file: 'lib', depth: 2 }, 'and either spelling');
  });

  test('no flag is all the way down, and no path is here', (assert) => {
    assert.deepEqual(getPathAndDepth('lib'), { file: 'lib', depth: Infinity });
    assert.deepEqual(getPathAndDepth(''), { file: '.', depth: Infinity });
    assert.deepEqual(getPathAndDepth('-L 3'), { file: '.', depth: 3 }, 'a depth on its own');
  });
});

// Everything that is not a file says what it is instead, and hands back the part that was real.
module('Commands | repl | findPath', { concurrency: true }, () => {
  test('a file says it is one, and brings nothing else', async (assert) => {
    await using directory = await sample('files-read');
    const found = findPath('index.ts', directory.path);

    // No contents: `.view` asks what a path is and then hands the line to `.cat`, so reading here
    // read every viewed file twice. `.cat` does its own reading now.
    assert.deepEqual(found, { kind: 'file' }, 'the kind, and nothing it did not need');
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
