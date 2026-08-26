import { module, test } from 'qunitx';
import { helpLines } from '../../lib/commands/repl/help.ts';
import { theme } from '../../lib/repl/theme.ts';
import '../helpers/custom-asserts.ts';

const plain = { style: () => '' };
const ESC = String.fromCharCode(27);

// This REPL has more names than commands — `.c`, `.s`, `.n`, `.e`, `.bt` — and a row apiece turns
// one screenful of help into two of the same sentences.
module('Commands | repl | help', { concurrency: true }, () => {
  test('names that say the same thing share the line they say it on', (assert) => {
    const lines = helpLines(
      {
        continue: { help: 'Carry on' },
        c: { help: 'Carry on' },
        resume: { help: 'Carry on' },
        url: { help: 'Print the URL' },
      },
      plain,
    ).split('\n');

    assert.strictEqual(lines.length, 2, 'four names, two things they do');
    assert.includes(lines[0] ?? '', '.continue', 'the spelled-out name leads');
    assert.includes(lines[0] ?? '', 'Carry on [aliases .c, .resume]', 'the short ones follow it');
  });

  test('one alias is an alias, and none is nothing at all', (assert) => {
    const lines = helpLines(
      { doc: { help: 'Explain' }, explain: { help: 'Explain' }, url: { help: 'Where' } },
      plain,
    );

    assert.includes(lines, 'Explain [alias .explain]');
    assert.includes(lines, 'Where', 'and a command on its own is left as it was');
    assert.notIncludes(lines, 'Where [', 'with no empty brackets after it');
  });

  test('the rows line up and read alphabetically', (assert) => {
    const lines = helpLines(
      { url: { help: 'Where' }, break: { help: 'Stop' }, imported: { help: 'What came in' } },
      plain,
    ).split('\n');

    assert.deepEqual(
      lines.map((line) => line.trimEnd().split(/\s{2,}/)[0]),
      ['.break', '.imported', '.url'],
    );
    assert.deepEqual(
      new Set(lines.map((line) => line.indexOf(line.trim().split(/\s{2,}/)[1] as string))),
      new Set([11]),
      'every description starts in the same column',
    );
  });

  test('what has no help is not a command anybody typed', (assert) => {
    assert.strictEqual(helpLines({ url: { help: 'Where' }, mystery: {} }, plain), '.url  Where');
  });

  test('the name and the aliases are told apart by colour', (assert) => {
    const lines = helpLines({ doc: { help: 'Explain' }, d: { help: 'Explain' } }, theme(true));

    assert.includes(lines, `${ESC}[34m.doc`, 'the name reads as the thing you type');
    assert.includes(lines, `${ESC}[90m[alias .d]`, 'and the aliases sit back');
  });
});
