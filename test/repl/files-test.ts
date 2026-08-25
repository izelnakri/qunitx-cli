import fs from 'node:fs/promises';
import path from 'node:path';
import { module, test } from 'qunitx';
import * as Files from '../../lib/repl/files.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';

const ESC = String.fromCharCode(27);
const plain = { style: () => '' };

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

// `.cat` takes a path, so it completes like a shell rather than like an expression — the
// filesystem is the only thing that knows, and history is as likely to name a file since renamed.
module('Repl | files | completion', { concurrency: true }, () => {
  test('only a path line has a path being typed on it', (assert) => {
    assert.strictEqual(Files.fragment('.cat lib/re'), 'lib/re');
    assert.strictEqual(Files.fragment('.view lib/re'), 'lib/re', 'under either name');
    assert.strictEqual(Files.fragment('.cat '), '', 'everything in the working directory');
    assert.strictEqual(Files.fragment('document.ti'), null, 'an expression is not a path');
    assert.strictEqual(Files.fragment('.scope'), null, 'and neither is a command without one');
  });

  test('what continues the path, spelled the way it was typed', async (assert) => {
    await using directory = await sample('files-complete');

    assert.deepEqual(Files.complete('re', directory.path), ['reports/', 'repl/'].sort());
    assert.deepEqual(Files.complete('index', directory.path), ['index.ts'], 'a file has no slash');
    assert.deepEqual(
      Files.complete('./re', directory.path),
      ['./reports/', './repl/'].sort(),
      'a prefix comes back the way it went in, rather than rebuilt',
    );
  });

  test('hidden entries stay hidden until a dot is typed', async (assert) => {
    await using directory = await sample('files-hidden');

    assert.false(
      Files.complete('', directory.path).includes('.hidden'),
      'the rule every shell has',
    );
    assert.deepEqual(Files.complete('.h', directory.path), ['.hidden'], 'and asking for one works');
  });

  test('a directory that cannot be read completes to nothing', async (assert) => {
    await using directory = await sample('files-unreadable');

    assert.deepEqual(Files.complete('nowhere/at/all', directory.path), []);
  });

  test('the suggestion is the rest of the shortest match', async (assert) => {
    await using directory = await sample('files-suggest');

    assert.strictEqual(Files.suggest('.cat rep', directory.path), 'l/', 'repl/ before reports/');
    assert.strictEqual(Files.suggest('.cat index', directory.path), '.ts');
    assert.strictEqual(Files.suggest('.cat ', directory.path), '', 'nothing typed, nothing meant');
    assert.strictEqual(Files.suggest('document.ti', directory.path), '', 'not a path line');
  });
});

// The listing itself: numbered the way anybody quoting a file writes it down.
module('Repl | files | numbered', { concurrency: true }, () => {
  test('one line per line, numbered from one', (assert) => {
    assert.strictEqual(Files.numbered('a\nb', 'x.txt', plain), '1 | a\n2 | b');
    assert.strictEqual(
      Files.numbered('a\n', 'x.txt', plain),
      '1 | a',
      'a trailing newline is not a line',
    );
  });

  test('numbers are right-aligned, so the code starts in one column', (assert) => {
    const lines = Files.numbered(
      Array.from({ length: 10 }, (_, at) => `x${at}`).join('\n'),
      'x.txt',
      plain,
    ).split('\n');

    assert.strictEqual(lines[0], ' 1 | x0', 'padded to the width of the longest number');
    assert.strictEqual(lines[9], '10 | x9', 'which is where the gutter stops drifting');
  });

  test('code is highlighted and prose is not', (assert) => {
    // The gutter is themed separately from the source, so this paints only the captures.
    const captures = { style: (name: string) => (name.startsWith('@') ? `${ESC}[31m` : '') };

    assert.includes(Files.numbered("const a = 'one'", 'x.ts', captures), ESC);
    assert.strictEqual(
      Files.numbered('const is not code here', 'notes.md', captures),
      '1 | const is not code here',
      'a markdown file run through a JavaScript tokenizer colours prose as keywords',
    );
  });

  test('the gutter takes its colour from the theme, under nvim’s name for it', (assert) => {
    const gutter = { style: (name: string) => (name === 'LineNr' ? `${ESC}[34m` : '') };

    assert.strictEqual(Files.numbered('a', 'x.txt', gutter), `${ESC}[34m1 |${ESC}[0m a`);
  });
});

// `-L 2` the way `tree` takes it, and the path is whatever is left over.
module('Repl | files | target', { concurrency: true }, () => {
  test('a depth flag anywhere, and the rest is where', (assert) => {
    assert.deepEqual(Files.target('-L 2 lib'), { depth: 2, path: 'lib' });
    assert.deepEqual(Files.target('lib -L 2'), { depth: 2, path: 'lib' }, 'in either order');
    assert.deepEqual(Files.target('-L2 lib'), { depth: 2, path: 'lib' }, 'and either spelling');
  });

  test('no flag is all the way down, and no path is here', (assert) => {
    assert.deepEqual(Files.target('lib'), { depth: Infinity, path: 'lib' });
    assert.deepEqual(Files.target(''), { depth: Infinity, path: '.' });
    assert.deepEqual(Files.target('-L 3'), { depth: 3, path: '.' }, 'a depth on its own');
  });

  test('the number after -L is not offered file completions', (assert) => {
    assert.strictEqual(Files.fragment('.tree -L 2'), null, 'a count is not a path');
    assert.strictEqual(Files.fragment('.tree -L '), null, 'and neither is what follows the flag');
    assert.strictEqual(Files.fragment('.tree -L 2 li'), 'li', 'the path after it still is');
  });
});

// A directory drawn the way `tree` draws one.
module('Repl | files | tree', { concurrency: true }, () => {
  test('the root, then what is under it', async (assert) => {
    await using directory = await sample('files-tree');
    const { listing } = Files.tree('.', directory.path, plain);
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

    const shallow = Files.tree('.', directory.path, plain, 1);
    const two = Files.tree('.', directory.path, plain, 2);
    const all = Files.tree('.', directory.path, plain);

    assert.notIncludes(shallow.listing, 'inner.ts', 'one level is the directory itself');
    assert.includes(two.listing, 'inner.ts', 'and two reaches inside it');
    assert.notIncludes(two.listing, 'buried.ts', 'but no further than it was asked');
    assert.includes(all.listing, 'buried.ts', 'where nothing said otherwise, all the way down');
  });

  test('hidden entries are left out, as `tree` leaves them out', async (assert) => {
    await using directory = await sample('files-tree-hidden');

    assert.notIncludes(Files.tree('.', directory.path, plain).listing, '.hidden');
  });

  test('it counts what it drew', async (assert) => {
    await using directory = await sample('files-tree-count');
    const { counted } = Files.tree('.', directory.path, plain);

    assert.deepEqual(counted, { directories: 2, files: 2 }, 'repl/ and reports/, index and notes');
  });

  test('directories are coloured apart from files', async (assert) => {
    await using directory = await sample('files-tree-colour');
    const blue = { style: (name: string) => (name === 'Directory' ? `${ESC}[34m` : '') };
    const { listing } = Files.tree('.', directory.path, blue);

    assert.includes(listing, `${ESC}[34mrepl/${ESC}[0m`);
    assert.includes(listing, 'index.ts', 'and the file is left plain');
    assert.notIncludes(listing, `${ESC}[34mindex.ts`);
  });
});

// Everything that is not a file says what it is instead, and hands back the part that was real.
module('Repl | files | read', { concurrency: true }, () => {
  test('a file comes back with its contents', async (assert) => {
    await using directory = await sample('files-read');
    const found = Files.read('index.ts', directory.path);

    assert.strictEqual(found.kind, 'file');
    assert.includes(found.kind === 'file' ? found.contents : '', "const a = 'one'");
  });

  test('a directory says so, and offers itself with a slash', async (assert) => {
    await using directory = await sample('files-directory');
    const found = Files.read('repl', directory.path);

    assert.strictEqual(found.kind, 'directory');
    assert.strictEqual(found.kind === 'directory' ? found.retype : '', 'repl/', 'ready to go on');
  });

  test('a path that goes wrong keeps the part that was right', async (assert) => {
    // What makes the second attempt a few keystrokes rather than the whole path again.
    await using directory = await sample('files-missing');

    const deep = Files.read('repl/nowhere.ts', directory.path);
    assert.strictEqual(deep.kind, 'missing');
    assert.strictEqual(deep.kind === 'missing' ? deep.retype : '', 'repl/');

    const shallow = Files.read('nowhere.ts', directory.path);
    assert.strictEqual(
      shallow.kind === 'missing' ? shallow.retype : 'x',
      '',
      'and offers nothing back when none of it was real',
    );
  });
});
