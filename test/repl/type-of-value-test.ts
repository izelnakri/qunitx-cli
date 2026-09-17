import { module, test } from 'qunitx';
import { typeOfValue } from '../../lib/repl/type-of-value.ts';
import '../helpers/custom-asserts.ts';

// The page holds values, not declarations: `const a: string = 'x'` left no trace of the annotation
// by the time it is a string. So the type is worked out from the value, which is what is knowable.
module('Repl | typeOfValue', { concurrency: true }, () => {
  test('a primitive is what `typeof` says it is', (assert) => {
    assert.strictEqual(typeOfValue('hi'), 'string');
    assert.strictEqual(typeOfValue(42), 'number');
    assert.strictEqual(typeOfValue(true), 'boolean');
    assert.strictEqual(typeOfValue(9n), 'bigint');
    assert.strictEqual(typeOfValue(Symbol('s')), 'symbol');
    assert.strictEqual(typeOfValue(undefined), 'undefined');
    assert.strictEqual(typeOfValue(null), 'null', 'which `typeof` gets wrong');
  });

  test('an array is the union of what is in it', (assert) => {
    assert.strictEqual(typeOfValue([1, 2, 3]), 'number[]');
    assert.strictEqual(typeOfValue([1, 'x']), '(number | string)[]', 'parenthesised, as TS needs');
    assert.strictEqual(typeOfValue([]), 'unknown[]', 'because nothing in it says nothing');
    assert.strictEqual(typeOfValue([1, 1, 1]), 'number[]', 'and a union says each type once');
  });

  test('an object is its shape', (assert) => {
    assert.strictEqual(typeOfValue({ a: 1, b: 'x' }), '{ a: number; b: string }');
    assert.strictEqual(typeOfValue({}), '{}');
    assert.strictEqual(typeOfValue({ 'not-a-name': 1 }), "{ 'not-a-name': number }", 'quoted');
    assert.strictEqual(typeOfValue({ a: { b: { c: 1 } } }, 1), '{ a: { b: object } }', 'to depth');
  });

  test('anything with a name of its own is called by it', (assert) => {
    class Widget {
      count = 1;
    }

    assert.strictEqual(typeOfValue(new Widget()), 'Widget', 'rather than its shape');
    assert.strictEqual(typeOfValue(new Date()), 'Date');
    assert.strictEqual(typeOfValue(/x/), 'RegExp');
    assert.strictEqual(typeOfValue(new Error('x')), 'Error');
    assert.strictEqual(typeOfValue(Object.create(null)), 'object', 'and one with no name at all');
  });

  test('the collections carry what they hold', (assert) => {
    assert.strictEqual(typeOfValue(new Map([['k', 1]])), 'Map<string, number>');
    assert.strictEqual(typeOfValue(new Map()), 'Map<unknown, unknown>');
    assert.strictEqual(typeOfValue(new Set([1, 2])), 'Set<number>');
    assert.strictEqual(typeOfValue(Promise.resolve(1)), 'Promise<unknown>', 'nobody can await it');
  });

  test('a function is what it takes, where its source will say', (assert) => {
    assert.strictEqual(
      typeOfValue((a: number, b: number) => a + b),
      '(a: unknown, b: unknown) => unknown',
    );
    assert.strictEqual(
      typeOfValue(() => 1),
      '() => unknown',
    );
    // A destructured parameter is not a name, and inventing one would be a worse answer.
    assert.strictEqual(
      typeOfValue(({ a }: { a: number }) => a),
      'Function',
    );
    assert.strictEqual(typeOfValue(Math.max), 'Function', 'and a native has no source to read');
  });

  test('depth is a floor, not a cliff', (assert) => {
    // `object` rather than a shape nobody asked for, and never a crash on something deep.
    const deep = { a: { b: { c: { d: { e: 1 } } } } };

    assert.strictEqual(typeOfValue(deep, 0), '{ a: object }');
    assert.includes(typeOfValue(deep, 4), 'e: number');
  });
});
