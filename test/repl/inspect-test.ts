import { module, test } from 'qunitx';
import { inspect } from '../../lib/repl/inspect.ts';
import '../helpers/custom-asserts.ts';

// `inspect` is the REPL's renderer on BOTH sides of the wire: Node calls it on the primitives CDP
// sends by value, and the page gets it as source text to render everything else. These run it in
// Node, which is where its behaviour can be pinned exactly.

module('Repl | inspect | primitives', { concurrency: true }, () => {
  test('renders each primitive the way a JavaScript prompt does', (assert) => {
    assert.equal(inspect(undefined), 'undefined');
    assert.equal(inspect(null), 'null');
    assert.equal(inspect(42), '42');
    assert.equal(inspect(-0), '-0', 'negative zero is distinguishable from 0');
    assert.equal(inspect(NaN), 'NaN');
    assert.equal(inspect(10n), '10n');
    assert.equal(inspect(true), 'true');
    assert.equal(inspect(Symbol('tag')), 'Symbol(tag)');
  });

  test('quotes strings, so a value cannot be mistaken for an identifier', (assert) => {
    assert.equal(inspect('hi'), "'hi'");
    assert.equal(inspect(''), "''");
    assert.equal(inspect("it's"), "'it\\'s'");
    assert.equal(inspect('a\nb\tc'), "'a\\nb\\tc'");
    assert.equal(inspect('back\\slash'), "'back\\\\slash'");
    assert.equal(inspect(String.fromCharCode(7)), "'\\x07'", 'controls with no spelling go as hex');
  });

  test('names functions and classes', (assert) => {
    assert.equal(
      inspect(function named() {}),
      '[Function: named]',
    );
    assert.equal(
      inspect(() => {}),
      '[Function (anonymous)]',
      'an unbound arrow has no name',
    );
    assert.equal(inspect(class Cart {}), '[class Cart]');
  });
});

module('Repl | inspect | composites', { concurrency: true }, () => {
  test('renders arrays and objects inline while they fit', (assert) => {
    assert.equal(inspect([1, 'two', null]), "[ 1, 'two', null ]");
    assert.equal(inspect([]), '[]');
    assert.equal(inspect({}), '{}');
    assert.equal(inspect({ a: 1, b: [2, 3] }), '{ a: 1, b: [ 2, 3 ] }');
    assert.equal(inspect({ 'not-an-ident': 1 }), "{ 'not-an-ident': 1 }");
  });

  test('renders the built-ins by their own notation', (assert) => {
    assert.equal(inspect(new Map([['k', 1]])), "Map(1) { 'k' => 1 }");
    assert.equal(inspect(new Set([1, 2])), 'Set(2) { 1, 2 }');
    assert.equal(inspect(new Date('2026-01-02T03:04:05.000Z')), '2026-01-02T03:04:05.000Z');
    assert.equal(inspect(/ab+c/gi), '/ab+c/gi');
    assert.equal(inspect(new Uint8Array([1, 2])), 'Uint8Array(2) [ 1, 2 ]');
  });

  test('prefixes a class instance with its constructor name', (assert) => {
    class Cart {
      items = 2;
    }

    assert.equal(inspect(new Cart()), 'Cart { items: 2 }');
    assert.equal(inspect(Object.create(null)), '[Object: null prototype] {}');
  });

  test('an error renders as its stack — the part a prompt is asked for', (assert) => {
    const error = new Error('boom');
    error.stack = 'Error: boom\n    at somewhere';

    assert.equal(inspect(error), 'Error: boom\n    at somewhere');
  });

  test('a DOM element renders as its own markup', (assert) => {
    // Duck-typed exactly as the renderer tests for it, because the process running this has no DOM
    // — which is the same reason the renderer cannot use `instanceof Element`.
    const element = { tagName: 'DIV', outerHTML: '<div id="qunit-fixture"></div>' };

    assert.equal(inspect(element), '<div id="qunit-fixture"></div>');
    assert.includes(
      inspect({ tagName: 'P', outerHTML: `<p>${'x'.repeat(400)}</p>` }),
      '…',
      'oversized markup is elided rather than printed whole',
    );
  });
});

module('Repl | inspect | limits', { concurrency: true }, () => {
  test('stops at the depth limit instead of recursing forever', (assert) => {
    assert.equal(inspect({ a: { b: { c: { d: 1 } } } }), '{ a: { b: { c: [Object] } } }');
    assert.equal(inspect([[[[1]]]]), '[ [ [ [Array] ] ] ]');
  });

  test('a circular reference is reported, not chased', (assert) => {
    const loop: Record<string, unknown> = { name: 'root' };
    loop.self = loop;

    assert.equal(inspect(loop), "{ name: 'root', self: [Circular] }");
  });

  test('breaks across lines rather than truncating what does not fit', (assert) => {
    const wide = { alpha: 'aaaaaaaaaaaaaaaaaaaa', beta: 'bbbbbbbbbbbbbbbbbbbb', gamma: 'ccccccc' };
    const rendered = inspect(wide);

    assert.includes(rendered, '\n', 'wide objects wrap');
    assert.includes(rendered, 'gamma', 'and keep every entry');
  });

  test('elides the tail of a very long array, saying how much is missing', (assert) => {
    const rendered = inspect(Array.from({ length: 120 }, (_value, index) => index));

    assert.includes(rendered, '… 20 more items');
  });

  test('a throwing getter is reported in place, and the rest still renders', (assert) => {
    const value = {
      ok: 1,
      get broken(): number {
        throw new Error('nope');
      },
    };

    assert.equal(inspect(value), '{ ok: 1, broken: [Getter threw: nope] }');
  });
});
