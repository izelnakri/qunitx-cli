import { module, test } from 'qunitx';
import { recent } from '../../lib/commands/repl.ts';
import { theme } from '../../lib/repl/theme.ts';
import '../helpers/custom-asserts.ts';

const ESC = String.fromCharCode(27);
const plain = { style: () => '' };

// What `history` prints: the last of what you entered, numbered, oldest first — so the newest is
// nearest the prompt, which is where you are reading from.
module('Commands | repl | history', { concurrency: true }, () => {
  test('oldest first, numbered from one', (assert) => {
    // readline keeps its history newest first, and this is the other way round on purpose.
    assert.strictEqual(recent(['b', 'a'], 16, plain), '1  a\n2  b\n');
  });

  test('a count takes the last of them, and keeps their numbers', (assert) => {
    const entries = ['d', 'c', 'b', 'a'];

    assert.strictEqual(recent(entries, 2, plain), '3  c\n4  d\n', 'the numbers say where they are');
    assert.strictEqual(
      recent(entries, 99, plain),
      '1  a\n2  b\n3  c\n4  d\n',
      'more than there is',
    );
  });

  test('numbers line up once there are ten of them', (assert) => {
    const entries = Array.from({ length: 10 }, (_, at) => `line ${9 - at}`);
    const lines = recent(entries, 10, plain).split('\n');

    assert.strictEqual(lines[0], ' 1  line 0', 'padded to the width of the longest');
    assert.strictEqual(lines[9], '10  line 9');
  });

  test('nothing entered prints nothing', (assert) => {
    assert.strictEqual(recent([], 16, plain), '');
  });

  test('the lines are painted, and the commands among them are not', (assert) => {
    const painted = recent(['.tree -L 1 lib', "const a = 'one'"], 16, theme(true));

    assert.includes(painted, `${ESC}[31mconst${ESC}[0m`, 'code reads as code');
    assert.includes(painted, '.tree -L 1 lib', 'and a dot command is not JavaScript to paint');
    assert.notIncludes(painted, `${ESC}[35mL`, 'so `-L` is not a type and `git` is not a call');
  });
});
