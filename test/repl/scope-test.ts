import { module, test } from 'qunitx';
import { formatScope } from '../../lib/repl/scope.ts';
import '../helpers/custom-asserts.ts';

// One name per line, its value beside it, where it came from after — the shape `.scope` and
// `.locals` share, so the two read the same however differently they were gathered.
module('Repl | scope', { concurrency: true }, () => {
  const ESC = String.fromCharCode(27);

  test('names line up, so the values can be read down the page', (assert) => {
    const lines = formatScope(
      [
        { name: 'label', value: "'one'", where: 'line 1' },
        { name: 'inspectMe', value: '[Function: inspectMe]', where: 'test/fixtures/repl.ts' },
      ],
      80,
    ).split('\n');

    assert.strictEqual(lines[0], `label      'one'  ${ESC}[90mline 1${ESC}[0m`);
    assert.includes(lines[1] ?? '', 'inspectMe  [Function: inspectMe]');
  });

  test('a name with nowhere to point at says nothing rather than empty columns', (assert) => {
    assert.strictEqual(formatScope([{ name: 'answer', value: '42', where: '' }], 80), 'answer  42');
  });

  test('one entry is one line, however the value was rendered', (assert) => {
    const wrapped = formatScope([{ name: 'big', value: '{\n  a: 1,\n  b: 2\n}', where: '' }], 80);

    assert.strictEqual(wrapped, 'big  { a: 1, b: 2 }', 'a scope listing is an index, not a dump');
  });

  test('a long value is cut to the terminal, and its colour closed behind it', (assert) => {
    const line = formatScope(
      [{ name: 'x', value: `${ESC}[33m'${'y'.repeat(80)}'`, where: '' }],
      20,
    );

    assert.true(line.length < 90, 'it was cut');
    assert.includes(line, `${ESC}[33m`, 'the colour it started in is kept');
    assert.true(line.endsWith(`…${ESC}[0m`), 'and closed, so it cannot leak into the terminal');
  });

  test('the width counts columns, not bytes — colour is free', (assert) => {
    const plain = formatScope([{ name: 'x', value: 'abcdefghij', where: '' }], 14);
    const coloured = formatScope([{ name: 'x', value: `${ESC}[33mabcdefghij`, where: '' }], 14);

    assert.strictEqual(plain, 'x  abcdefghij', 'fits exactly, so nothing is cut');
    assert.includes(coloured, 'abcdefghij', 'and the same text still fits once painted');
  });

  test('nothing in scope formats to nothing, and the caller says what that means', (assert) => {
    assert.strictEqual(formatScope([], 80), '');
  });
});
