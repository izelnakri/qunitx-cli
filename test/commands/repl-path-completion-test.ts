import fs from 'node:fs/promises';
import path from 'node:path';
import { module, test } from 'qunitx';
import {
  pathBeingTyped,
  pathSuggestion,
  pathsContinuing,
} from '../../lib/commands/repl/completion.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';
// `.cat` takes a path, so it completes like a shell rather than like an expression — the
// filesystem is the only thing that knows, and history is as likely to name a file since renamed.

module('Commands | repl | completing a path', { concurrency: true }, () => {
  test('only a path line has a path being typed on it', (assert) => {
    assert.strictEqual(pathBeingTyped('.cat lib/re'), 'lib/re');
    assert.strictEqual(pathBeingTyped('.view lib/re'), 'lib/re', 'under either name');
    assert.strictEqual(pathBeingTyped('.cat '), '', 'everything in the working directory');
    assert.strictEqual(pathBeingTyped('document.ti'), null, 'an expression is not a path');
    assert.strictEqual(pathBeingTyped('.scope'), null, 'and neither is a command without one');
  });

  test('what continues the path, spelled the way it was typed', async (assert) => {
    await using directory = await sample('files-complete');

    assert.deepEqual(pathsContinuing('re', directory.path), ['reports/', 'repl/'].sort());
    assert.deepEqual(pathsContinuing('index', directory.path), ['index.ts'], 'a file has no slash');
    assert.deepEqual(
      pathsContinuing('./re', directory.path),
      ['./reports/', './repl/'].sort(),
      'a prefix comes back the way it went in, rather than rebuilt',
    );
  });

  test('hidden entries stay hidden until a dot is typed', async (assert) => {
    await using directory = await sample('files-hidden');

    assert.false(
      pathsContinuing('', directory.path).includes('.hidden'),
      'the rule every shell has',
    );
    assert.deepEqual(
      pathsContinuing('.h', directory.path),
      ['.hidden'],
      'and asking for one works',
    );
  });

  test('a directory that cannot be read completes to nothing', async (assert) => {
    await using directory = await sample('files-unreadable');

    assert.deepEqual(pathsContinuing('nowhere/at/all', directory.path), []);
  });

  test('the suggestion is the rest of the shortest match', async (assert) => {
    await using directory = await sample('files-suggest');

    assert.strictEqual(pathSuggestion('.cat rep', directory.path), 'l/', 'repl/ before reports/');
    assert.strictEqual(pathSuggestion('.cat index', directory.path), '.ts');
    assert.strictEqual(pathSuggestion('.cat ', directory.path), '', 'nothing typed, nothing meant');
    assert.strictEqual(pathSuggestion('document.ti', directory.path), '', 'not a path line');
  });

  test('the number after -L is not offered file completions', (assert) => {
    assert.strictEqual(pathBeingTyped('.tree -L 2'), null, 'a count is not a path');
    assert.strictEqual(pathBeingTyped('.tree -L '), null, 'and neither is what follows the flag');
    assert.strictEqual(pathBeingTyped('.tree -L 2 li'), 'li', 'the path after it still is');
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
