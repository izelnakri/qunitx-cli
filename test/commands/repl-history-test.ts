import { module, test } from 'qunitx';
import { lastEntered } from '../../lib/commands/repl/commands/history.ts';
import { pageGoneMessage } from '../../lib/commands/repl/index.ts';
import { theme } from '../../lib/repl/theme.ts';
import '../helpers/custom-asserts.ts';

const ESC = String.fromCharCode(27);
const plain = { painter: () => (text: string) => text };

// What `history` prints: the last of what you entered, numbered, oldest first — so the newest is
// nearest the prompt, which is where you are reading from.
module('Commands | repl | history', { concurrency: true }, () => {
  test('oldest first, numbered from one', (assert) => {
    // readline keeps its history newest first, and this is the other way round on purpose.
    assert.strictEqual(lastEntered(['b', 'a'], 16, plain), '1  a\n2  b\n');
  });

  test('a count takes the last of them, and keeps their numbers', (assert) => {
    const entries = ['d', 'c', 'b', 'a'];

    assert.strictEqual(
      lastEntered(entries, 2, plain),
      '3  c\n4  d\n',
      'the numbers say where they are',
    );
    assert.strictEqual(
      lastEntered(entries, 99, plain),
      '1  a\n2  b\n3  c\n4  d\n',
      'more than there is',
    );
  });

  test('numbers line up once there are ten of them', (assert) => {
    const entries = Array.from({ length: 10 }, (_, at) => `line ${9 - at}`);
    const lines = lastEntered(entries, 10, plain).split('\n');

    assert.strictEqual(lines[0], ' 1  line 0', 'padded to the width of the longest');
    assert.strictEqual(lines[9], '10  line 9');
  });

  test('nothing entered prints nothing', (assert) => {
    assert.strictEqual(lastEntered([], 16, plain), '');
  });

  test('the lines are painted, and the commands among them are not', (assert) => {
    const painted = lastEntered(['.tree -L 1 lib', "const a = 'one'"], 16, theme(true));

    assert.includes(painted, `${ESC}[31mconst${ESC}[0m`, 'code reads as code');
    assert.includes(painted, '.tree -L 1 lib', 'and a dot command is not JavaScript to paint');
    assert.notIncludes(painted, `${ESC}[35mL`, 'so `-L` is not a type and `git` is not a call');
  });
});

// A REPL's whole value is the page it is holding. When that goes, the bindings, the DOM and the
// module state go at once — so there is nothing to offer but what happened and what to type.
module('Commands | repl | a page that has gone', { concurrency: true }, () => {
  test('it says what was lost, not just what failed', (assert) => {
    const said = pageGoneMessage(['node', 'cli.ts', 'repl', 'a.ts']);

    assert.includes(said, 'the page is gone', 'what happened');
    assert.includes(said, 'nothing here to carry on with', 'and why the session is ending');
  });

  test('and how to start again, in the words that were typed', (assert) => {
    // Reopening a page would not bring any of it back — it would be the session you get by
    // running the command again, which the shell already remembers.
    assert.includes(
      pageGoneMessage(['node', 'cli.ts', 'repl', 'a.ts', 'b.ts']),
      'qunitx repl a.ts b.ts',
    );
    assert.includes(
      pageGoneMessage(['node', 'cli.ts']),
      'Run qunitx repl again',
      'where there were no args',
    );
  });
});
