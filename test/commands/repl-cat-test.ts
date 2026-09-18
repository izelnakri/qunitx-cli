import { module, test } from 'qunitx';
import { withLineNumbers } from '../../lib/commands/repl/commands/cat.ts';
import '../helpers/custom-asserts.ts';

const ESC = String.fromCharCode(27);
const plain = { style: () => '' };

// The listing itself: numbered the way anybody quoting a file writes it down.
module('Commands | repl | .cat line numbers', { concurrency: true }, () => {
  test('one line per line, numbered from one', (assert) => {
    assert.strictEqual(withLineNumbers('a\nb', 'x.txt', plain), '1 | a\n2 | b');
    assert.strictEqual(
      withLineNumbers('a\n', 'x.txt', plain),
      '1 | a',
      'a trailing newline is not a line',
    );
  });

  test('numbers are right-aligned, so the code starts in one column', (assert) => {
    const lines = withLineNumbers(
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

    assert.includes(withLineNumbers("const a = 'one'", 'x.ts', captures), ESC);
    assert.strictEqual(
      withLineNumbers('const is not code here', 'notes.md', captures),
      '1 | const is not code here',
      'a markdown file run through a JavaScript tokenizer colours prose as keywords',
    );
  });

  test('the gutter takes its colour from the theme, under nvim’s name for it', (assert) => {
    const gutter = { style: (name: string) => (name === 'LineNr' ? `${ESC}[34m` : '') };

    assert.strictEqual(withLineNumbers('a', 'x.txt', gutter), `${ESC}[34m1 |${ESC}[0m a`);
  });
});
