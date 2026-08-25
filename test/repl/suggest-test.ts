import { module, test } from 'qunitx';
import { split, suggest } from '../../lib/repl/suggest.ts';
import { suggestionStyle } from '../../lib/commands/repl.ts';
import '../helpers/custom-asserts.ts';

// The zsh habit: what you were about to type, offered greyed-out, taken with Ctrl-F. Only the
// REMAINDER is returned, so the terminal can draw it after the cursor without measuring anything.
module('Repl | suggest', { concurrency: true }, () => {
  test('a name in the page beats a line in history', (assert) => {
    // The complaint this exists for: `doc` meant `document`, and being handed `document.title`
    // means deleting back to the part you wanted.
    assert.strictEqual(
      suggest('doc', {
        names: ['document', 'documentPictureInPicture'],
        history: ['document.title'],
      }),
      'ument',
    );
  });

  test('and then history extends it, so the two hand off', (assert) => {
    assert.strictEqual(
      suggest('document', { names: ['document'], history: ['document.title'] }),
      '.title',
      'the name is taken, so what is left to offer is what you did with it',
    );
  });

  test('the shortest name wins', (assert) => {
    assert.strictEqual(suggest('win', { names: ['windowClient', 'window'] }), 'dow');
  });

  test('a tie goes to the name you have used', (assert) => {
    // `console` and `confirm` are both seven characters, and only one of them is what anybody
    // typing `con` at a prompt meant.
    const names = ['confirm', 'console'];

    assert.strictEqual(suggest('con', { names }), 'firm', 'alphabetical, with nothing to go on');
    assert.strictEqual(
      suggest('con', { names, history: ['console.log(1)'] }),
      'sole',
      'and the evidence wins where there is any',
    );
    assert.strictEqual(
      suggest('con', { names, history: ['consoleXYZ()'] }),
      'firm',
      'a longer name that merely starts the same is not evidence of using this one',
    );
  });

  test('properties are completed off the path they hang on', (assert) => {
    assert.strictEqual(suggest('document.qu', { names: ['querySelector'] }), 'erySelector');
  });

  test('keywords are offered where no page name matched', (assert) => {
    assert.strictEqual(suggest('debu', {}), 'gger', 'the one this REPL is for');
    assert.strictEqual(
      suggest('con', { names: ['console'] }),
      'sole',
      'a real name still comes first — `con` is not `const` when `console` is there',
    );
  });

  test('inside a string it is text, not a name', (assert) => {
    // `break` is a keyword that starts with `b`; `'<b` is the beginning of some HTML. Without
    // knowing the difference a REPL suggests keywords into the middle of your markup.
    assert.strictEqual(
      suggest("d.body.innerHTML = '<b", { history: ["d.body.innerHTML = '<b>x</b>'"] }),
      ">x</b>'",
      'so history answers, which is the only source that can',
    );
    assert.strictEqual(
      suggest("querySelector('#b", {}),
      '',
      'and with no history there is nothing to say, rather than `break`',
    );
  });

  test('newest wins — the last thing you did is the thing you meant', (assert) => {
    // History arrives newest first, and it stops at the first hit rather than ranking the rest:
    // this runs on every keystroke, and the work must not grow with the session.
    assert.strictEqual(suggest('test(', { history: ['test(b)', 'test(a)'] }), 'b)');
  });

  test('nothing to add is nothing to say', (assert) => {
    const history = ['const a = 1'];

    assert.strictEqual(suggest('const a = 1', { history }), '', 'an exact match is not a hint');
    assert.strictEqual(
      suggest('', { history: ['anything'] }),
      '',
      'an empty line suggests nothing',
    );
    assert.strictEqual(suggest('zzz', { history: ['document.title'] }), '', 'no match, no ghost');
    assert.strictEqual(
      suggest('doc', { names: ['doc'] }),
      '',
      'a name equal to the token adds nothing',
    );
  });

  test('it matches on the prefix, not on a substring', (assert) => {
    assert.strictEqual(
      suggest('ment', { names: ['document'], history: ['document.title'] }),
      '',
      'a suggestion continues the line',
    );
  });
});

// What decides whether the page is asked at all — and, for anything that is not a plain path,
// whether somebody's function call gets made because they pressed a key.
module('Repl | suggest | split', { concurrency: true }, () => {
  test('a bare name has no base', (assert) => {
    assert.deepEqual(split('doc'), { base: '', token: 'doc' });
    assert.deepEqual(split('1 + doc'), { base: '', token: 'doc' }, 'and neither has one mid-line');
  });

  test('a dotted path is the base, however deep', (assert) => {
    assert.deepEqual(split('document.ti'), { base: 'document', token: 'ti' });
    assert.deepEqual(split('a.b.c'), { base: 'a.b', token: 'c' });
    assert.deepEqual(split('document.'), { base: 'document', token: '' }, 'everything on it');
  });

  test('nothing that would have to be RUN to answer', (assert) => {
    assert.strictEqual(split('foo().b'), null, 'finding out what foo() returns means calling it');
    assert.strictEqual(split('list[0].n'), null, 'and an index is an expression too');
    assert.strictEqual(split('1.'), null, 'a decimal point is not a property access');
  });

  test('nothing where a name has not started', (assert) => {
    assert.strictEqual(split(''), null);
    assert.strictEqual(split('const x = '), null, 'every name in scope is not an offer');
  });

  test('nothing inside a string, where the text only looks like a name', (assert) => {
    assert.strictEqual(split("alert('he"), null);
    assert.strictEqual(split('alert("he'), null, 'either quote');
    assert.strictEqual(split("alert('a\\'b"), null, 'an escaped quote does not close it');
    assert.deepEqual(split("alert('hi') && do"), { base: '', token: 'do' }, 'closed is closed');
  });

  test("a template's expression is code again", (assert) => {
    assert.deepEqual(split('`a ${doc'), { base: '', token: 'doc' });
    assert.strictEqual(split('`a ${x} b'), null, 'and the text around it is still text');
  });
});

// "Muted" is a different colour on a light terminal than on a dark one, and only the developer
// knows which they are on — so it is read from the environment rather than guessed at.
module('Repl | suggestionStyle', { concurrency: true }, () => {
  const ESC = String.fromCharCode(27);
  const withEnv = <T>(vars: Record<string, string | undefined>, body: () => T): T => {
    const before = { ...process.env };
    Object.assign(process.env, vars);
    try {
      return body();
    } finally {
      for (const key of Object.keys(vars)) delete process.env[key];
      Object.assign(process.env, before);
    }
  };

  test('defaults to a dim grey when nothing says otherwise', (assert) => {
    assert.strictEqual(
      withEnv(
        { QUNITX_SUGGEST_STYLE: undefined, ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE: undefined },
        suggestionStyle,
      ),
      `${ESC}[90m`,
    );
  });

  test("zsh's own setting is honoured, in both spellings it uses", (assert) => {
    assert.strictEqual(
      withEnv({ ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE: 'fg=8' }, suggestionStyle),
      `${ESC}[38;5;8m`,
      'a palette index',
    );
    assert.strictEqual(
      withEnv({ ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE: 'fg=#585858' }, suggestionStyle),
      `${ESC}[38;2;88;88;88m`,
      'and a truecolour triple',
    );
  });

  test('QUNITX_SUGGEST_STYLE wins, for anyone not running zsh', (assert) => {
    assert.strictEqual(
      withEnv(
        { QUNITX_SUGGEST_STYLE: 'fg=240', ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE: 'fg=8' },
        suggestionStyle,
      ),
      `${ESC}[38;5;240m`,
    );
  });
});
