import fs from 'node:fs/promises';
import path from 'node:path';
import { module, test } from 'qunitx';
import { drawTree } from '../../lib/commands/repl/commands/tree.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';

import type { ReplContext } from '../../lib/commands/repl/command.ts';

const ESC = String.fromCharCode(27);
const plain = { painter: () => (text: string) => text };

// A directory drawn the way `tree` draws one, with the two sentences under it.

module('Commands | repl | .tree drawing', { concurrency: true }, () => {
  test('the root, then what is under it', async (assert) => {
    await using directory = await sample('files-tree');
    const listing = drawTree(at(directory.path, plain), '.', Infinity);
    const lines = listing.split('\n');

    assert.strictEqual(lines[0], './', 'the root, said as a directory');
    assert.includes(listing, '├── index.ts');
    assert.includes(listing, '└── reports/', 'the last one closes the branch');
  });

  test('depth is levels down, and one is what is right here', async (assert) => {
    await using directory = await sample('files-tree-depth');
    await fs.mkdir(path.join(directory.path, 'repl', 'deeper'));
    await fs.writeFile(path.join(directory.path, 'repl', 'inner.ts'), 'export {};\n');
    await fs.writeFile(path.join(directory.path, 'repl', 'deeper', 'buried.ts'), 'export {};\n');

    const shallow = drawTree(at(directory.path, plain), '.', 1);
    const two = drawTree(at(directory.path, plain), '.', 2);
    const all = drawTree(at(directory.path, plain), '.', Infinity);

    assert.notIncludes(shallow, 'inner.ts', 'one level is the directory itself');
    assert.includes(two, 'inner.ts', 'and two reaches inside it');
    assert.notIncludes(two, 'buried.ts', 'but no further than it was asked');
    assert.includes(all, 'buried.ts', 'where nothing said otherwise, all the way down');
  });

  test('hidden entries are left out, as `tree` leaves them out', async (assert) => {
    await using directory = await sample('files-tree-hidden');

    assert.notIncludes(drawTree(at(directory.path, plain), '.', Infinity), '.hidden');
  });

  test('it counts what it drew, under the drawing', async (assert) => {
    await using directory = await sample('files-tree-count');
    const drawn = drawTree(at(directory.path, plain), '.', Infinity);

    // The tally is part of the answer now rather than a field beside it — `tree` prints one, and
    // a listing whose size you have to count yourself made you do arithmetic.
    assert.includes(drawn, '2 directories, 2 files', 'repl/ and reports/, index and notes');
  });

  test('directories are coloured apart from files', async (assert) => {
    await using directory = await sample('files-tree-colour');
    const blue = { painter: painting('Directory', `${ESC}[34m`) };
    const listing = drawTree(at(directory.path, blue), '.', Infinity);

    assert.includes(listing, `${ESC}[34mrepl/${ESC}[0m`);
    assert.includes(listing, 'index.ts', 'and the file is left plain');
    assert.notIncludes(listing, `${ESC}[34mindex.ts`);
  });
});

/** A theme that paints one capture and leaves the rest alone — the fake a drawing test needs. */
function painting(capture: string, style: string) {
  return (name: string) => (text: string) => (name === capture ? `${style}${text}${ESC}[0m` : text);
}

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

/** Just enough of a context for a drawing: where to resolve from, and what to colour with. */
function at(
  cwd: string,
  palette: { painter: (name: string) => (text: string) => string },
): ReplContext {
  return { cwd, palette } as unknown as ReplContext;
}
