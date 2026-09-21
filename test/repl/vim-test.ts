import { module, test } from 'qunitx';
import { newVimState, pressKey } from '../../lib/repl/vim.ts';
import '../helpers/custom-asserts.ts';

import type { VimState, VimStep } from '../../lib/repl/vim.ts';

const ESC = String.fromCharCode(27);

// The grammar is a pure function, so these are typed AT it: a line, a caret, some keys, and what
// vim would have left behind. Every expectation below is what vim itself does — the special cases
// (`cw` behaving as `ce`, `dw` exclusive against `de` inclusive, `t` stopping short) are the ones
// a vi-mode gets wrong, so they are the ones written down.

module('Repl | vim | modes', { concurrency: true }, () => {
  test('a session starts in insert, because a fresh prompt is for typing', (assert) => {
    assert.strictEqual(newVimState().mode, 'insert');
  });

  test('insert hands every key to readline, which already owns typing', (assert) => {
    const step = pressKey(newVimState(), { text: 'a', cursor: 1 }, 'b');

    assert.strictEqual(step.action, 'forward');
    assert.strictEqual(step.line.text, 'a', 'the reducer did not touch it');
  });

  test('Escape leaves insert and steps the caret back onto the last character typed', (assert) => {
    const step = pressKey(newVimState(), { text: 'const', cursor: 5 }, ESC);

    assert.strictEqual(step.state.mode, 'normal');
    assert.strictEqual(step.line.cursor, 4, 'normal mode sits ON a character, never past one');
  });

  test('i, I, a and A are the four ways back in', (assert) => {
    assert.strictEqual(at('  ab', 3, 'i').state.mode, 'insert');
    assert.strictEqual(at('  ab', 3, 'I').line.cursor, 2, 'the first non-blank');
    assert.strictEqual(at('ab', 0, 'a').line.cursor, 1, 'after the caret');
    assert.strictEqual(at('ab', 0, 'A').line.cursor, 2, 'past the end, which insert allows');
  });

  test('Escape in normal mode abandons a half-typed command', (assert) => {
    const step = at('const total', 0, `d${ESC}w`);

    assert.strictEqual(step.line.text, 'const total', 'the `d` was dropped, so `w` only moved');
    assert.strictEqual(step.line.cursor, 6);
  });

  test('a key that cannot start anything does not stick to the next one', (assert) => {
    const step = at('const total', 0, 'zw');

    assert.strictEqual(step.state.pending, '');
    assert.strictEqual(step.line.cursor, 6, '`w` still worked on its own');
  });

  test('Enter submits, and leaves the prompt in insert for the next line', (assert) => {
    const step = at('1 + 1', 0, '\r');

    assert.strictEqual(step.action, 'submit');
    assert.strictEqual(step.state.mode, 'insert');
  });

  test('k and j are history, which is what they mean at a prompt', (assert) => {
    assert.strictEqual(at('a', 0, 'k').action, 'historyPrev');
    assert.strictEqual(at('a', 0, 'j').action, 'historyNext');
  });
});

module('Repl | vim | motions', { concurrency: true }, () => {
  const line = 'const total = 1;';

  test('h and l, and neither runs off the end', (assert) => {
    assert.strictEqual(at(line, 5, 'h').line.cursor, 4);
    assert.strictEqual(at(line, 5, 'l').line.cursor, 6);
    assert.strictEqual(at(line, 0, 'h').line.cursor, 0, 'nothing before the first column');
    assert.strictEqual(at(line, 15, 'l').line.cursor, 15, 'nor after the last character');
  });

  test('0, ^ and $', (assert) => {
    assert.strictEqual(at('  ab', 3, '0').line.cursor, 0);
    assert.strictEqual(at('  ab', 3, '^').line.cursor, 2);
    assert.strictEqual(at(line, 0, '$').line.cursor, 15, 'the last character, not past it');
  });

  test('w stops at a change of character class, and W does not', (assert) => {
    // The distinction readline's forward-word does not have, and the reason a vi-mode built on it
    // gets every motion over an expression slightly wrong.
    assert.strictEqual(at('const.total', 0, 'w').line.cursor, 5, 'w stops on the dot');
    assert.strictEqual(at('const.total', 0, 'W').line.cursor, 10, 'W runs to the end of the line');
    assert.strictEqual(at('a bb ccc', 0, 'w').line.cursor, 2);
  });

  test('b goes back to the start of a word, B past punctuation', (assert) => {
    assert.strictEqual(at(line, 6, 'b').line.cursor, 0);
    assert.strictEqual(at('const.total', 10, 'b').line.cursor, 6);
    assert.strictEqual(at('const.total', 10, 'B').line.cursor, 0);
  });

  test('e and E land on the last character of a word', (assert) => {
    assert.strictEqual(at(line, 0, 'e').line.cursor, 4);
    assert.strictEqual(at(line, 4, 'e').line.cursor, 10, 'already at an end, so the next word');
    assert.strictEqual(at('const.total', 0, 'E').line.cursor, 10);
  });

  test('a count repeats a motion', (assert) => {
    assert.strictEqual(at(line, 0, '2w').line.cursor, 12);
    assert.strictEqual(at(line, 0, '3l').line.cursor, 3);
    assert.strictEqual(at(line, 15, '5h').line.cursor, 10);
  });

  test('0 leads a motion and follows a count, which is vim’s own rule', (assert) => {
    assert.strictEqual(at('0123456789abc', 5, '0').line.cursor, 0, 'a bare 0 is the first column');
    assert.strictEqual(at('0123456789abc', 0, '10|').line.cursor, 9, 'and 10 is a count');
  });

  test('f and t, forward; F and T, back', (assert) => {
    assert.strictEqual(at(line, 0, 'f=').line.cursor, 12);
    assert.strictEqual(at(line, 0, 't=').line.cursor, 11, 't stops one short');
    assert.strictEqual(at(line, 15, 'F=').line.cursor, 12);
    assert.strictEqual(at(line, 15, 'T=').line.cursor, 13);
  });

  test('a find that is not there leaves the caret alone', (assert) => {
    assert.strictEqual(at(line, 0, 'fz').line.cursor, 0);
  });

  test('a count picks the nth occurrence', (assert) => {
    assert.strictEqual(at('a.b.c.d', 0, '2f.').line.cursor, 3);
  });

  test('; repeats the last find and , reverses it', (assert) => {
    assert.strictEqual(at('a.b.c.d', 0, 'f.;').line.cursor, 3);
    assert.strictEqual(at('a.b.c.d', 0, 'f.;,').line.cursor, 1, 'back to the first one');
  });

  test('; with nothing found yet does nothing', (assert) => {
    assert.strictEqual(at('a.b', 0, ';').line.cursor, 0);
  });
});

module('Repl | vim | operators', { concurrency: true }, () => {
  const line = 'const total = 1;';

  test('dw is exclusive and de is inclusive — the classic off-by-one', (assert) => {
    assert.strictEqual(at(line, 0, 'dw').line.text, 'total = 1;', 'dw takes the space too');
    assert.strictEqual(at(line, 0, 'de').line.text, ' total = 1;', 'de stops at the word');
  });

  test('d with a find takes the character it landed on, and t stops short', (assert) => {
    assert.strictEqual(at(line, 0, 'df=').line.text, ' 1;');
    assert.strictEqual(at(line, 0, 'dt=').line.text, '= 1;');
  });

  test('d$ and D are the same thing', (assert) => {
    assert.strictEqual(at(line, 11, 'd$').line.text, 'const total');
    assert.strictEqual(at(line, 11, 'D').line.text, 'const total');
  });

  test('d0 deletes backwards, because a backward motion is a backward span', (assert) => {
    assert.strictEqual(at(line, 6, 'd0').line.text, 'total = 1;');
    assert.strictEqual(at(line, 6, 'db').line.text, 'total = 1;');
  });

  test('dd empties the line', (assert) => {
    assert.strictEqual(at(line, 6, 'dd').line.text, '');
  });

  test('a count applies to the operator’s motion', (assert) => {
    assert.strictEqual(at(line, 0, 'd2w').line.text, '= 1;');
    assert.strictEqual(at(line, 0, '2dw').line.text, '= 1;', 'either side of the operator');
  });

  test('cw behaves as ce, which is vim’s own special case', (assert) => {
    // Changing a word and having the space after it vanish is not what anybody means by `cw`.
    const step = at(line, 0, 'cw');

    assert.strictEqual(step.line.text, ' total = 1;');
    assert.strictEqual(step.state.mode, 'insert');
  });

  test('cw on a blank is still a plain w, because there is no word to end', (assert) => {
    assert.strictEqual(at('a   b', 1, 'cw').line.text, 'ab');
  });

  test('c leaves you in insert and d does not', (assert) => {
    assert.strictEqual(at(line, 0, 'cc').state.mode, 'insert');
    assert.strictEqual(at(line, 0, 'dd').state.mode, 'normal');
    assert.strictEqual(at(line, 0, 'C').state.mode, 'insert');
    assert.strictEqual(at(line, 0, 'S').state.mode, 'insert');
  });

  test('y moves nothing and fills the register', (assert) => {
    const step = at(line, 0, 'yw');

    assert.strictEqual(step.line.text, line, 'nothing was taken out');
    assert.strictEqual(step.state.register, 'const ');
  });

  test('what an operator took is what p puts back', (assert) => {
    assert.strictEqual(at(line, 0, 'dw').state.register, 'const ');
    assert.strictEqual(at(line, 0, 'x').state.register, 'c');
    assert.strictEqual(at(line, 3, 'X').state.register, 'n');
  });

  test('an operator with a motion that goes nowhere changes nothing', (assert) => {
    assert.strictEqual(at(line, 0, 'dfz').line.text, line);
  });
});

module('Repl | vim | the small edits', { concurrency: true }, () => {
  test('x and X, with counts, and neither runs off an end', (assert) => {
    assert.strictEqual(at('abcd', 0, 'x').line.text, 'bcd');
    assert.strictEqual(at('abcd', 0, '3x').line.text, 'd');
    assert.strictEqual(
      at('abcd', 0, '9x').line.text,
      '',
      'a count past the end takes what is there',
    );
    assert.strictEqual(at('abcd', 2, 'X').line.text, 'acd');
    assert.strictEqual(at('abcd', 0, 'X').line.text, 'abcd', 'nothing before the first column');
  });

  test('the caret never rests past the last character after an edit', (assert) => {
    assert.strictEqual(at('ab', 1, 'x').line.cursor, 0, 'deleting the last one steps back');
  });

  test('s and S clear and drop into insert', (assert) => {
    assert.strictEqual(at('abcd', 1, 's').line.text, 'acd');
    assert.strictEqual(at('abcd', 1, '2s').line.text, 'ad');
    assert.strictEqual(at('abcd', 1, 'S').line.text, '');
  });

  test('r replaces under the caret without leaving normal mode', (assert) => {
    const step = at('abcd', 1, 'rZ');

    assert.strictEqual(step.line.text, 'aZcd');
    assert.strictEqual(step.state.mode, 'normal');
    assert.strictEqual(step.line.cursor, 1);
  });

  test('r with a count replaces that many, and refuses to overrun', (assert) => {
    assert.strictEqual(at('abcd', 1, '2rZ').line.text, 'aZZd');
    assert.strictEqual(at('abcd', 3, '2rZ').line.text, 'abcd', 'not enough left, so nothing');
  });

  test('~ flips case and moves on', (assert) => {
    assert.strictEqual(at('abc', 0, '~').line.text, 'Abc');
    assert.strictEqual(at('abc', 0, '3~').line.text, 'ABC');
    assert.strictEqual(at('ABc', 0, '~').line.text, 'aBc');
  });

  test('p puts after the caret and P before it', (assert) => {
    assert.strictEqual(at('abc', 0, 'xp').line.text, 'bac');
    assert.strictEqual(at('abc', 0, 'xP').line.text, 'abc', 'straight back where it came from');
  });

  test('a count pastes that many times', (assert) => {
    assert.strictEqual(at('abc', 0, 'x2p').line.text, 'baac');
  });

  test('p with an empty register does nothing', (assert) => {
    assert.strictEqual(at('abc', 0, 'p').line.text, 'abc');
  });

  test('a linewise register replaces the line, so ddp puts it back', (assert) => {
    // vim would put it on a new line; a prompt has none, so it goes back where it was.
    assert.strictEqual(at('const a = 1;', 4, 'ddp').line.text, 'const a = 1;');
    assert.strictEqual(at('const a = 1;', 4, 'yyp').line.text, 'const a = 1;');
    assert.true(at('const a = 1;', 4, 'yy').state.registerIsLine);
    assert.false(at('const a = 1;', 4, 'yw').state.registerIsLine, 'a motion yank is not');
  });

  test('Y takes the whole line, as vim’s Y does', (assert) => {
    assert.strictEqual(at('const a = 1;', 4, 'Y').state.register, 'const a = 1;');
  });
});

module('Repl | vim | text objects', { concurrency: true }, () => {
  test('iw is the word under the caret, aw takes the space after it', (assert) => {
    assert.strictEqual(at('const total = 1;', 7, 'diw').line.text, 'const  = 1;');
    assert.strictEqual(at('const total = 1;', 7, 'daw').line.text, 'const = 1;');
  });

  test('i( and a( reach inside a call, and count the nesting', (assert) => {
    assert.strictEqual(at('foo(bar, baz)', 5, 'di(').line.text, 'foo()');
    assert.strictEqual(at('foo(bar, baz)', 5, 'da(').line.text, 'foo');
    // The inner pair, not the outer one — which is the whole point of counting depth.
    assert.strictEqual(at('f(g(x), y)', 4, 'di(').line.text, 'f(g(), y)');
  });

  test('every spelling of a pair names the same pair', (assert) => {
    assert.strictEqual(at('foo(bar)', 5, 'di)').line.text, 'foo()');
    assert.strictEqual(at('foo(bar)', 5, 'dib').line.text, 'foo()');
    assert.strictEqual(at('foo[bar]', 5, 'di[').line.text, 'foo[]');
    assert.strictEqual(at('foo{bar}', 5, 'di{').line.text, 'foo{}');
    assert.strictEqual(at('foo<bar>', 5, 'diB').line.text, 'foo<bar>', 'B is braces, not angles');
  });

  test('ci" is most of why anybody turns this on for a code prompt', (assert) => {
    const step = at('const a = "hi there";', 0, 'ci"');

    assert.strictEqual(step.line.text, 'const a = "";');
    assert.strictEqual(step.line.cursor, 11);
    assert.strictEqual(step.state.mode, 'insert');
  });

  test('a" takes the quotes with it, and the other two quotes work too', (assert) => {
    assert.strictEqual(at('a = "hi";', 5, 'da"').line.text, 'a = ;');
    assert.strictEqual(at("a = 'hi';", 5, "di'").line.text, "a = '';");
    assert.strictEqual(at('a = `hi`;', 5, 'di`').line.text, 'a = ``;');
  });

  test('an escaped quote is not a quote', (assert) => {
    assert.strictEqual(at('a = "say \\"hi\\"";', 5, 'di"').line.text, 'a = "";');
  });

  test('an object with no pair around it changes nothing', (assert) => {
    assert.strictEqual(at('no brackets here', 3, 'di(').line.text, 'no brackets here');
    assert.strictEqual(at('no quotes here', 3, 'di"').line.text, 'no quotes here');
  });

  test('an unclosed pair changes nothing rather than guessing', (assert) => {
    assert.strictEqual(at('foo(bar', 5, 'di(').line.text, 'foo(bar');
  });
});

module('Repl | vim | undo and repeat', { concurrency: true }, () => {
  test('u goes back one change', (assert) => {
    assert.strictEqual(at('abc', 0, 'xu').line.text, 'abc');
    assert.strictEqual(at('const total', 0, 'dwu').line.text, 'const total');
  });

  test('u goes back through several, oldest last', (assert) => {
    assert.strictEqual(at('abcd', 0, 'xxu').line.text, 'bcd');
    assert.strictEqual(at('abcd', 0, 'xxuu').line.text, 'abcd');
  });

  test('u with nothing to undo does nothing', (assert) => {
    assert.strictEqual(at('abc', 0, 'u').line.text, 'abc');
  });

  test('a motion is not a change, so u does not step over one', (assert) => {
    assert.strictEqual(at('abcd', 0, 'xlu').line.text, 'abcd');
  });

  test('. does the last change again, wherever the caret is now', (assert) => {
    assert.strictEqual(at('aaaa', 0, 'x.').line.text, 'aa');
    assert.strictEqual(at('one two three', 0, 'dw.').line.text, 'three');
  });

  test('. after a change that opened insert does not leave it open', (assert) => {
    // There is nobody about to type the rest of it, which is what makes a bare `.` different
    // from the `cw` it is repeating.
    const step = at('one two three', 0, `cwX${ESC}w.`);

    assert.strictEqual(step.state.mode, 'normal');
  });

  test('. with nothing changed yet does nothing', (assert) => {
    assert.strictEqual(at('abc', 0, '.').line.text, 'abc');
  });
});

module('Repl | vim | half-typed commands', { concurrency: true }, () => {
  test('an operator waits for its motion', (assert) => {
    assert.strictEqual(at('const total', 0, 'd').state.pending, 'd');
    assert.strictEqual(at('const total', 0, 'd').line.text, 'const total');
  });

  test('a count waits, and so does a count after an operator', (assert) => {
    assert.strictEqual(at('const total', 0, '2').state.pending, '2');
    assert.strictEqual(at('const total', 0, 'd2').state.pending, 'd2');
  });

  test('f waits for its character, even one that looks like a command', (assert) => {
    assert.strictEqual(at('a d b', 0, 'f').state.pending, 'f');
    assert.strictEqual(at('a d b', 0, 'fd').line.cursor, 2, 'the d was the argument');
  });

  test('a text object waits twice', (assert) => {
    assert.strictEqual(at('foo(bar)', 5, 'di').state.pending, 'di');
    assert.strictEqual(at('foo(bar)', 5, 'd').state.pending, 'd');
  });

  test('a finished command clears what it was built from', (assert) => {
    assert.strictEqual(at('const total', 0, 'd2w').state.pending, '');
  });

  test('an operator with a nonsense target is dropped whole', (assert) => {
    const step = at('const total', 0, 'dz');

    assert.strictEqual(step.line.text, 'const total');
    assert.strictEqual(step.state.pending, '', 'and nothing is held against the next key');
  });
});

module('Repl | vim | an empty line', { concurrency: true }, () => {
  test('every motion and edit is a no-op rather than a throw', (assert) => {
    for (const keys of ['h', 'l', 'w', 'b', 'e', '$', '0', 'x', 'X', 'dw', 'dd', 'p', 'diw', '~']) {
      const step = at('', 0, keys);

      assert.strictEqual(step.line.text, '', `\`${keys}\` left it empty`);
      assert.strictEqual(step.line.cursor, 0, `\`${keys}\` left the caret at 0`);
    }
  });
});

/**
 * Types `keys` at a line already in normal mode, and answers with where it ended up.
 *
 * Normal mode, because that is what every test above is about; the Escape that gets there is one
 * of the mode tests rather than a preamble on all of them.
 */
function at(text: string, cursor: number, keys: string): VimStep {
  const state: VimState = { ...newVimState(), mode: 'normal' };
  let step: VimStep = { state, line: { text, cursor }, action: 'none' };
  for (const key of keys) step = pressKey(step.state, step.line, key);

  return step;
}
