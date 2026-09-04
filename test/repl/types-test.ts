import { module, test } from 'qunitx';
import { describeType } from '../../lib/repl/types.ts';
import '../helpers/custom-asserts.ts';

// The page holds values, not declarations: `const a: string = 'x'` left no trace of the annotation
// by the time it is a string. So the type is worked out from the value, which is what is knowable.
module('Repl | types', { concurrency: true }, () => {
  test('a primitive is what `typeof` says it is', (assert) => {
    assert.strictEqual(describeType('hi'), 'string');
    assert.strictEqual(describeType(42), 'number');
    assert.strictEqual(describeType(true), 'boolean');
    assert.strictEqual(describeType(9n), 'bigint');
    assert.strictEqual(describeType(Symbol('s')), 'symbol');
    assert.strictEqual(describeType(undefined), 'undefined');
    assert.strictEqual(describeType(null), 'null', 'which `typeof` gets wrong');
  });

  test('an array is the union of what is in it', (assert) => {
    assert.strictEqual(describeType([1, 2, 3]), 'number[]');
    assert.strictEqual(describeType([1, 'x']), '(number | string)[]', 'parenthesised, as TS needs');
    assert.strictEqual(describeType([]), 'unknown[]', 'because nothing in it says nothing');
    assert.strictEqual(describeType([1, 1, 1]), 'number[]', 'and a union says each type once');
  });

  test('an object is its shape', (assert) => {
    assert.strictEqual(describeType({ a: 1, b: 'x' }), '{ a: number; b: string }');
    assert.strictEqual(describeType({}), '{}');
    assert.strictEqual(describeType({ 'not-a-name': 1 }), "{ 'not-a-name': number }", 'quoted');
    assert.strictEqual(describeType({ a: { b: { c: 1 } } }, 1), '{ a: { b: object } }', 'to depth');
  });

  test('anything with a name of its own is called by it', (assert) => {
    class Widget {
      count = 1;
    }

    assert.strictEqual(describeType(new Widget()), 'Widget', 'rather than its shape');
    assert.strictEqual(describeType(new Date()), 'Date');
    assert.strictEqual(describeType(/x/), 'RegExp');
    assert.strictEqual(describeType(new Error('x')), 'Error');
    assert.strictEqual(describeType(Object.create(null)), 'object', 'and one with no name at all');
  });

  test('the collections carry what they hold', (assert) => {
    assert.strictEqual(describeType(new Map([['k', 1]])), 'Map<string, number>');
    assert.strictEqual(describeType(new Map()), 'Map<unknown, unknown>');
    assert.strictEqual(describeType(new Set([1, 2])), 'Set<number>');
    assert.strictEqual(describeType(Promise.resolve(1)), 'Promise<unknown>', 'nobody can await it');
  });

  test('a function is what it takes, where its source will say', (assert) => {
    assert.strictEqual(
      describeType((a: number, b: number) => a + b),
      '(a: unknown, b: unknown) => unknown',
    );
    assert.strictEqual(
      describeType(() => 1),
      '() => unknown',
    );
    // A destructured parameter is not a name, and inventing one would be a worse answer.
    assert.strictEqual(
      describeType(({ a }: { a: number }) => a),
      'Function',
    );
    assert.strictEqual(describeType(Math.max), 'Function', 'and a native has no source to read');
  });

  test('depth is a floor, not a cliff', (assert) => {
    // `object` rather than a shape nobody asked for, and never a crash on something deep.
    const deep = { a: { b: { c: { d: { e: 1 } } } } };

    assert.strictEqual(describeType(deep, 0), '{ a: object }');
    assert.includes(describeType(deep, 4), 'e: number');
  });
});
