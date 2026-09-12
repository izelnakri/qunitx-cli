import { module, test } from 'qunitx';
import { LINES, excerpt, limits } from '../../lib/repl/excerpt.ts';
import { theme } from '../../lib/repl/theme.ts';
import '../helpers/custom-asserts.ts';

const ESC = String.fromCharCode(27);
const plain = { style: () => '' };
const show = (source: string, line: number, given?: { before: number; after: number }) =>
  excerpt(source, line, plain, given).split('\n');

const FUNCTION = [
  '// a note',
  'export function inspectMe() {',
  '  const answer = 42;',
  '  debugger;',
  '',
  '  return answer;',
  '}',
].join('\n');

// Which `debugger` this is, seen rather than worked out from a file and a number. Both edges are
// found rather than counted to: up to where the scope starts, down to what it answers.
module('Repl | excerpt', { concurrency: true }, () => {
  test('it stops going up at the line that opens the block', (assert) => {
    const lines = show(FUNCTION, 4);

    assert.strictEqual(lines[0], '  2 │ export function inspectMe() {', 'the signature');
    assert.strictEqual(lines.length, 5, 'and nothing above it, though six were allowed');
  });

  test('it stops going down at the return', (assert) => {
    const lines = show(FUNCTION, 4);

    assert.strictEqual(lines.at(-1), '  6 │   return answer;', 'what the frame is about to answer');
  });

  test('the line the page stopped on is marked', (assert) => {
    const lines = show(FUNCTION, 4);

    assert.strictEqual(lines[2], '> 4 │   debugger;');
    assert.true(
      lines.filter((line) => line.startsWith('>')).length === 1,
      'exactly one line is where you are',
    );
  });

  test('a return too far away is not walked to', (assert) => {
    // One line below says where you are; three more of unrelated body says nothing.
    const long = [
      'function big() {',
      ...Array.from({ length: 10 }, (_, at) => `  const step${at} = ${at};`),
      '  debugger;',
      ...Array.from({ length: 10 }, (_, at) => `  const more${at} = ${at};`),
      '  return 1;',
      '}',
    ].join('\n');
    const lines = show(long, 12);

    assert.strictEqual(lines.at(-1), '  13 │   const more0 = 0;', 'one line, and no further');
    assert.strictEqual(lines.length, LINES.before + 2, 'with the full window above it');
  });

  test('a bracket inside a string does not open a block', (assert) => {
    // Counted from one pass over the whole source, because a line tokenized on its own cannot know
    // it is in the middle of a template.
    const lines = show("const a = '{';\nconst b = 2;\ndebugger;\nreturn b;", 3);

    assert.strictEqual(lines[0], `  1 │ const a = '{';`);
    assert.strictEqual(lines.length, 4, 'the string did not swallow the window');
  });

  test('a one-line function is its own excerpt', (assert) => {
    const typed = 'function izel() { let mine = 22; debugger; return 44 };';

    assert.deepEqual(show(typed, 1), [`> 1 │ ${typed}`]);
  });

  test('nothing to show is shown as nothing', (assert) => {
    assert.strictEqual(excerpt('', 1, plain), '');
    assert.strictEqual(excerpt('a\nb', 9, plain), '', 'a line that is not in the source');
    assert.strictEqual(excerpt('a\nb', 0, plain), '', 'nor one before the first');
  });

  test('asking for none gives none', (assert) => {
    assert.strictEqual(excerpt(FUNCTION, 4, plain, { before: 0, after: 0 }), '');
  });

  test('the source is painted and the mark is not the gutter', (assert) => {
    const painted = excerpt(FUNCTION, 4, theme(true));

    assert.includes(painted, `${ESC}[31mdebugger${ESC}[0m`, 'the source reads as source');
    assert.includes(painted, `${ESC}[90m`, 'the lines around it have a dim gutter');
  });
});

// One variable, in the spelling the REPL's other settings use.
module('Repl | excerpt | limits', { concurrency: true }, () => {
  const withEnv = <T>(value: string | undefined, body: () => T): T => {
    const before = process.env.QUNITX_REPL_CONTEXT;
    if (value === undefined) delete process.env.QUNITX_REPL_CONTEXT;
    else process.env.QUNITX_REPL_CONTEXT = value;
    try {
      return body();
    } finally {
      if (before === undefined) delete process.env.QUNITX_REPL_CONTEXT;
      else process.env.QUNITX_REPL_CONTEXT = before;
    }
  };

  test('nothing set is the default window', (assert) => {
    assert.deepEqual(withEnv(undefined, limits), LINES);
  });

  test('one number is how many lines above', (assert) => {
    assert.deepEqual(withEnv('10', limits), { before: 10, after: LINES.after });
  });

  test('two are both edges', (assert) => {
    assert.deepEqual(withEnv('10,2', limits), { before: 10, after: 2 });
  });

  test('zero on its own means none at all', (assert) => {
    // A breakpoint you already know your way around does not need a map every time.
    assert.deepEqual(withEnv('0', limits), { before: 0, after: 0 });
  });

  test('what cannot be read is the default rather than an error', (assert) => {
    assert.deepEqual(withEnv('lots', limits), LINES);
    assert.deepEqual(withEnv('-3', limits), LINES, 'a window cannot be negative');
  });
});
