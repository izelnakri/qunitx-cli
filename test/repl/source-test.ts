import { module, test } from 'qunitx';
import { candidates, isIncomplete } from '../../lib/repl/source.ts';
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
