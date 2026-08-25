import { module, test } from 'qunitx';
import { candidates, declaration, isIncomplete } from '../../lib/repl/source.ts';
import '../helpers/custom-asserts.ts';

module('Repl | source | candidates', { concurrency: true }, () => {
  test('ordinary input is evaluated exactly as typed', (assert) => {
    assert.deepEqual(candidates('1 + 1'), ['1 + 1']);
    assert.deepEqual(candidates('  await fetch("/x")  '), ['await fetch("/x")']);
    assert.deepEqual(candidates('let x = 1'), ['let x = 1']);
  });

  test('`{…}` is offered as an object first and a block second', (assert) => {
    // The ambiguity a REPL has to resolve: `{ a: 1 }` parses as a block with a label, which
    // evaluates to 1, and as an object, which is what anyone typing it meant.
    assert.deepEqual(candidates('{ a: 1 }'), ['({ a: 1 })', '{ a: 1 }']);
    assert.deepEqual(candidates('{}'), ['({})', '{}']);
  });

  test('a `{`-leading statement that is NOT an object still has its bare form to fall back on', (assert) => {
    assert.equal(candidates('{ let a = 1; }')[1], '{ let a = 1; }');
  });
});

module('Repl | source | isIncomplete', { concurrency: true }, () => {
  test('the parser running out of input means "keep reading"', (assert) => {
    for (const description of [
      'SyntaxError: Unexpected end of input',
      'SyntaxError: Unexpected end of script',
      'SyntaxError: Unterminated template literal',
      'SyntaxError: Unterminated string literal',
      'SyntaxError: Unterminated comment',
    ]) {
      assert.true(isIncomplete(description), description);
    }
  });

  test('a genuine syntax error is reported, not waited on', (assert) => {
    for (const description of [
      "SyntaxError: Unexpected token ';'",
      "SyntaxError: Unexpected identifier 'a'",
      'SyntaxError: Invalid or unexpected token',
      'ReferenceError: boom is not defined',
    ]) {
      assert.false(isIncomplete(description), description);
    }
  });
});

// At a breakpoint the page evaluates each input in a scope of its own and throws it away
// afterwards, so a `let` there answers `undefined` like a declaration should and then does not
// exist — the worst of both, because it looks like it worked.
module('Repl | source | declaration', { concurrency: true }, () => {
  test('the name and the value are read apart', (assert) => {
    // Apart, because they belong in different places: the value is evaluated where it was typed,
    // so it can see the frame, and the name is bound somewhere that outlasts the evaluation.
    assert.deepEqual(declaration('let me = { age: 32 }'), {
      name: 'me',
      value: '({ age: 32 })',
      blockScoped: true,
    });
  });

  test('the value keeps whatever was written, parenthesised', (assert) => {
    // `let doubled = answer * 2` has to see the frame's `answer`, and only the frame can.
    assert.strictEqual(declaration('const doubled = answer * 2')?.value, '(answer * 2)');
    assert.strictEqual(
      declaration('let a = { b: 1 };')?.value,
      '({ b: 1 })',
      'a literal, not a block',
    );
  });

  test('what the block owns, and what JavaScript hoists out of it', (assert) => {
    for (const keyword of ['let', 'const']) {
      assert.true(declaration(`${keyword} a = 1`)?.blockScoped, `${keyword} belongs to the block`);
    }

    assert.false(declaration('var a = 1')?.blockScoped, 'var is hoisted out of it');
    assert.true(declaration('class Person {}')?.blockScoped, 'a class belongs to the block');
    assert.false(declaration('function hello() {}')?.blockScoped, 'a function is hoisted out');
  });

  test('a named function or class keeps its name', (assert) => {
    assert.strictEqual(declaration('function hello() {}')?.name, 'hello');
    assert.strictEqual(declaration('async function hello() {}')?.name, 'hello');
    assert.strictEqual(declaration('function* hello() {}')?.name, 'hello');
    assert.strictEqual(declaration('class Person {}')?.name, 'Person');
    assert.strictEqual(
      declaration('function hello() {}')?.value,
      '(function hello() {})',
      'in parentheses, which is what makes a definition an expression',
    );
  });

  test('what is not a declaration is left alone', (assert) => {
    assert.strictEqual(declaration('me.age'), null);
    assert.strictEqual(declaration('1 + 1'), null);
    assert.strictEqual(declaration(''), null);
    assert.strictEqual(declaration('let a'), null, 'nothing is bound to anything');
  });

  test('unfinished input is not a declaration yet', (assert) => {
    // Treating it as one would turn "keep typing" into a syntax error.
    assert.strictEqual(declaration('let a = {'), null);
    assert.strictEqual(declaration('function hello() {'), null);
  });

  test('two names at once are left alone rather than half-understood', (assert) => {
    assert.strictEqual(declaration('let a = 1, b = 2'), null);
    assert.ok(declaration('let a = [1, 2]'), 'a comma inside something is not a second declarator');
    assert.ok(declaration('let a = f(1, 2)'), 'wherever the something is');
  });

  test('a destructuring pattern is left alone too', (assert) => {
    assert.strictEqual(declaration('const { a } = obj'), null, 'one name is read, or none');
  });
});
