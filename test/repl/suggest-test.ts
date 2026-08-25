import { module, test } from 'qunitx';
import { suggest } from '../../lib/repl/suggest.ts';
import { suggestionStyle } from '../../lib/commands/repl.ts';
import '../helpers/custom-asserts.ts';

// The zsh habit: what you were about to type, offered greyed-out, taken with Ctrl-F. Only the
// REMAINDER is returned, so the terminal can draw it after the cursor without measuring anything.
module('Repl | suggest', { concurrency: true }, () => {
  test('offers the rest of the most recent matching line', (assert) => {
    assert.strictEqual(suggest('doc', ['document.title', 'const a = 1']), 'ument.title');
  });

  test('newest wins — the last thing you did is the thing you meant', (assert) => {
    // History arrives newest first, and it stops at the first hit rather than ranking the rest:
    // this runs on every keystroke, and the work must not grow with the session.
    assert.strictEqual(suggest('test(', ['test(b)', 'test(a)']), 'b)');
  });

  test('nothing to add is nothing to say', (assert) => {
    assert.strictEqual(suggest('const a = 1', ['const a = 1']), '', 'an exact match is not a hint');
    assert.strictEqual(suggest('', ['anything']), '', 'an empty line suggests nothing');
    assert.strictEqual(suggest('zzz', ['document.title']), '', 'no match, no ghost');
  });

  test('it matches on the prefix, not on a substring', (assert) => {
    assert.strictEqual(suggest('ment', ['document.title']), '', 'a suggestion continues the line');
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
