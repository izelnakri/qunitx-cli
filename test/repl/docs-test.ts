import { module, test } from 'qunitx';
import { blockAt, commentAbove, renderDoc, signature } from '../../lib/repl/docs.ts';
import { theme } from '../../lib/repl/theme.ts';
import '../helpers/custom-asserts.ts';

const ESC = String.fromCharCode(27);
const plain = { style: () => '' };

// What somebody wrote above a declaration, which is the only place a prompt can find out what a
// value is FOR.
module('Repl | docs | commentAbove', { concurrency: true }, () => {
  test('a block comment, with its markers off', (assert) => {
    const source = [
      '/**',
      ' * What it does.',
      ' *',
      ' * And how.',
      ' */',
      'export const a = 1;',
    ].join('\n');

    assert.deepEqual(commentAbove(source, 6), ['What it does.', '', 'And how.']);
  });

  test('a run of line comments', (assert) => {
    assert.deepEqual(commentAbove('// one\n// two\nconst a = 1;', 3), ['one', 'two']);
  });

  test('a one-line block comment', (assert) => {
    assert.deepEqual(commentAbove('/** Short. */\nconst a = 1;', 2), ['Short.']);
  });

  test('nothing directly above is nothing said about it', (assert) => {
    // A comment separated by a blank line is describing something else.
    assert.deepEqual(commentAbove('// about something else\n\nconst a = 1;', 3), []);
    assert.deepEqual(commentAbove('const a = 1;\nconst b = 2;', 2), []);
    assert.deepEqual(
      commentAbove('const a = 1;', 1),
      [],
      'and nothing at all above the first line',
    );
  });

  test('decorators do not come between a comment and what it describes', (assert) => {
    const source = ['// what it does', '@decorated', 'class Thing {}'].join('\n');

    assert.deepEqual(commentAbove(source, 3), ['what it does']);
  });
});

// Prose is a comment; the example in it is code. That example is the part anybody scrolls to.
module('Repl | docs | renderDoc', { concurrency: true }, () => {
  test('prose is muted and the fenced example is painted as code', (assert) => {
    const painted = renderDoc(['What it does.', '```ts', 'const a = 1;', '```'], theme(true));
    const lines = painted.split('\n');

    assert.includes(lines[0] ?? '', `${ESC}[90m`, 'the sentence is a comment');
    assert.includes(lines[2] ?? '', `${ESC}[31mconst${ESC}[0m`, 'the example is code');
    assert.includes(lines[3] ?? '', `${ESC}[90m`, 'and the fence closes as a comment again');
  });

  test('an unstyled theme is the words alone', (assert) => {
    assert.strictEqual(renderDoc(['a', '```ts', 'b', '```'], plain), 'a\n```ts\nb\n```');
    assert.strictEqual(renderDoc([], plain), '', 'and nothing written is nothing to print');
  });
});

// How to call something is the question asked most often, so a `.doc` leads with it.
module('Repl | docs | signature', { concurrency: true }, () => {
  test('it stops where the body begins', (assert) => {
    const source = 'export function helper(value: number): number {\n  return 1;\n}';

    assert.strictEqual(signature(source, 1), 'export function helper(value: number): number');
  });

  test('a brace inside the parameters is not the body', (assert) => {
    const source = 'function a({ x }: { x: number } = { x: 1 }) {\n}';

    assert.strictEqual(signature(source, 1), 'function a({ x }: { x: number } = { x: 1 })');
  });

  test('one written over several lines comes back as one', (assert) => {
    const source = [
      'function big(',
      '  first: number,',
      '  second: number,',
      '): void {',
      '}',
    ].join('\n');

    assert.strictEqual(
      signature(source, 1),
      'function big( first: number, second: number, ): void',
    );
  });

  test('what has no body is all of it', (assert) => {
    assert.strictEqual(signature('const a = 1;\nconst b = 2;', 1), 'const a = 1;');
    assert.strictEqual(signature('const a = 1;', 9), '', 'and a line that is not there is nothing');
  });
});

// What `.view` and `.copy` hand over: the whole declaration, not the line it starts on.
module('Repl | docs | blockAt', { concurrency: true }, () => {
  test('a declaration through the brace that closes it', (assert) => {
    const source = 'function a() {\n  return 1;\n}\nconst b = 2;';

    assert.strictEqual(blockAt(source, 1), 'function a() {\n  return 1;\n}');
  });

  test('a brace in a string does not close it early', (assert) => {
    const source = `function a() {\n  const b = '}';\n  return b;\n}`;

    assert.includes(blockAt(source, 1), 'return b;', 'the whole body, string and all');
  });

  test('something with no body is the line it is written on', (assert) => {
    assert.strictEqual(blockAt('const a = 1;\nconst b = 2;', 1), 'const a = 1;');
  });
});
