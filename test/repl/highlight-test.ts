import { module, test } from 'qunitx';
import { depth, highlight, tokenize } from '../../lib/repl/highlight.ts';
import { ansiStyle, theme } from '../../lib/repl/theme.ts';
import '../helpers/custom-asserts.ts';

const ESC = String.fromCharCode(27);
const captures = (source: string) => tokenize(source).map((token) => token.capture);
const text = (source: string) =>
  tokenize(source).map((token) => source.slice(token.start, token.end));

// Captured under the names nvim's treesitter queries use, so a theme written for an editor means
// the same thing at this prompt. A scanner, not a parser: it answers what colour, how deep, and
// whether this is a string — and nothing that would need types to know.
module('Repl | highlight | tokenize', { concurrency: true }, () => {
  test('keywords are grouped the way nvim groups them', (assert) => {
    assert.deepEqual(captures('const'), ['@keyword']);
    assert.deepEqual(captures('return'), ['@keyword.return']);
    assert.deepEqual(captures('if'), ['@keyword.conditional']);
    assert.deepEqual(captures('await'), ['@keyword.coroutine'], 'so a theme can colour it apart');
  });

  test('literals are captured by what they are', (assert) => {
    assert.deepEqual(captures("'hi'"), ['@string']);
    assert.deepEqual(captures('42'), ['@number']);
    assert.deepEqual(captures('1.5e3'), ['@number'], 'exponent and point included');
    assert.deepEqual(captures('true'), ['@boolean']);
    assert.deepEqual(captures('null'), ['@constant.builtin']);
    assert.deepEqual(captures('this'), ['@variable.builtin']);
  });

  test('an identifier is read from what surrounds it', (assert) => {
    assert.deepEqual(captures('a.b'), ['@variable', '@punctuation.delimiter', '@property']);
    assert.deepEqual(captures('foo()').slice(0, 1), ['@function.call'], 'a call, before a bracket');
    assert.deepEqual(captures('new Map').slice(1), ['@constructor'], 'a constructor, after `new`');
    assert.deepEqual(captures('Map').slice(0, 1), ['@type'], 'and a type by convention alone');
    assert.deepEqual(
      captures('a.new'),
      ['@variable', '@punctuation.delimiter', '@property'],
      'a keyword after a dot is a property — it is not a keyword there',
    );
  });

  test('a template is a string with code in the middle of it', (assert) => {
    // The pieces interleave rather than nest, which is how they appear on screen.
    assert.deepEqual(captures('`hi ${name}!`'), ['@string', '@variable', '@string']);
    assert.deepEqual(text('`hi ${name}!`'), ['`hi ${', 'name', '}!`'], 'and cover it exactly once');
  });

  test('a slash is a regular expression or a division, by what precedes it', (assert) => {
    assert.deepEqual(captures('/ab/.test'), [
      '@string.regexp',
      '@punctuation.delimiter',
      '@property',
    ]);
    assert.deepEqual(text('/a[/]b/g'), ['/a[/]b/g'], 'a class can hold the delimiter, and flags');
    assert.deepEqual(captures('a / b'), ['@variable', '@operator', '@variable'], 'after a value');
  });

  test('comments run to where comments end', (assert) => {
    assert.deepEqual(text('1 // two\n3'), ['1', '// two', '3'], 'a line comment stops at the line');
    assert.deepEqual(text('/* a */ 1'), ['/* a */', '1']);
    assert.deepEqual(text('/* unclosed'), ['/* unclosed'], 'and an unclosed one takes the rest');
  });

  test('every token is a real slice, in order and without overlap', (assert) => {
    // What the painter depends on: it walks tokens and copies the gaps, so an overlap paints the
    // same characters twice and a token out of order scrambles the line.
    const source = 'const a = { b: `x${y.z}`, c: /r/g }; // done';
    let previousEnd = 0;
    for (const token of tokenize(source)) {
      assert.true(token.start >= previousEnd, `${token.capture} starts after the last one ended`);
      assert.true(token.end > token.start, `${token.capture} covers something`);
      previousEnd = token.end;
    }
  });
});

// What a continuation prompt counts. A brace inside a string is text, which is the whole reason
// this is counted from tokens rather than characters.
module('Repl | highlight | depth', { concurrency: true }, () => {
  test('one level per bracket left open', (assert) => {
    assert.strictEqual(depth('const a = {'), 1);
    assert.strictEqual(depth('const a = { b: ['), 2);
    assert.strictEqual(depth('const a = { b: [ c('), 3);
  });

  test('closing one comes back up', (assert) => {
    assert.strictEqual(depth('const a = { b: [ ]'), 1);
    assert.strictEqual(depth('const a = {}'), 0);
  });

  test('a bracket in a string or a comment is not a bracket', (assert) => {
    assert.strictEqual(depth("const a = { b: '}'"), 1, 'the brace in the string is text');
    assert.strictEqual(depth('const a = { // }'), 1, 'and so is the one in the comment');
    assert.strictEqual(depth('const a = `${b}`'), 0, 'a template’s own braces still count out');
  });

  test('more closes than opens is still the top level', (assert) => {
    assert.strictEqual(depth('a}}}'), 0, 'a prompt cannot be less deep than not nested at all');
  });
});

// Colour comes from the terminal's own palette unless the developer says otherwise, so the prompt
// matches the shell it was opened from without anybody configuring anything.
module('Repl | theme', { concurrency: true }, () => {
  const withEnv = <T>(value: string | undefined, body: () => T): T => {
    const before = process.env.QUNITX_REPL_THEME;
    if (value === undefined) delete process.env.QUNITX_REPL_THEME;
    else process.env.QUNITX_REPL_THEME = value;
    try {
      return body();
    } finally {
      if (before === undefined) delete process.env.QUNITX_REPL_THEME;
      else process.env.QUNITX_REPL_THEME = before;
    }
  };

  test('a capture with no style of its own inherits its parent’s, as in nvim', (assert) => {
    const palette = withEnv(undefined, () => theme(true));

    assert.strictEqual(palette.style('@keyword.return'), palette.style('@keyword'));
    assert.strictEqual(palette.style('@punctuation.bracket'), palette.style('@punctuation'));
    assert.strictEqual(palette.style('@nothing.like.this'), '', 'and nothing invented for a miss');
  });

  test('the environment overrides, in the spelling zsh and nvim share', (assert) => {
    const palette = withEnv('@string=fg=green @keyword=fg=magenta,bold', () => theme(true));

    assert.strictEqual(palette.style('@string'), `${ESC}[32m`);
    assert.strictEqual(palette.style('@keyword'), `${ESC}[1;35m`, 'modifiers come with it');
    assert.strictEqual(
      palette.style('@keyword.return'),
      `${ESC}[1;35m`,
      'and an override is inherited the same way a default is',
    );
  });

  test('a session that reads no colour is painted with none', (assert) => {
    assert.strictEqual(
      theme(false).style('@keyword'),
      '',
      'so a pipe carries the text and no more',
    );
  });

  test('the three colour spellings that turn up in the wild', (assert) => {
    assert.strictEqual(ansiStyle('fg=yellow'), `${ESC}[33m`, 'the terminal’s own yellow');
    assert.strictEqual(ansiStyle('fg=8'), `${ESC}[38;5;8m`, 'a palette index');
    assert.strictEqual(ansiStyle('fg=#585858'), `${ESC}[38;2;88;88;88m`, 'a truecolour triple');
    assert.strictEqual(ansiStyle('nonsense'), '', 'and a typo styles nothing rather than failing');
  });
});

// The painter itself: tokens in, a line the terminal draws out. Unstyled captures cost no bytes.
module('Repl | highlight | paint', { concurrency: true }, () => {
  const plain = { style: () => '' };

  test('an unstyled theme returns the source unchanged', (assert) => {
    const source = 'const a = { b: `x${y}`, c: /r/g }; // done';

    assert.strictEqual(highlight(source, plain), source, 'byte for byte');
  });

  test('what is painted is still the line that was typed', (assert) => {
    const source = "test('adds', (a) => a.equal(1 + 1, 2))";
    const painted = highlight(source, theme(true));
    const stripped = painted
      .split(ESC)
      .map((part, index) => (index === 0 ? part : part.slice(part.indexOf('m') + 1)));

    assert.strictEqual(stripped.join(''), source, 'colour adds nothing and removes nothing');
    assert.notStrictEqual(painted, source, 'and it did paint');
  });
});
