import { module, test } from 'qunitx';
import { load } from 'js-yaml';
import dumpYaml from '../../lib/tap/dump-yaml.ts';
import '../helpers/custom-asserts.ts';

module('TAP | dumpYaml | primitives', { concurrency: true }, () => {
  test('null round-trips', (assert) => {
    assert.strictEqual(roundtrip(null), null);
  });

  test('undefined serializes as null', (assert) => {
    assert.strictEqual(roundtrip(undefined), null);
  });

  test('boolean true round-trips', (assert) => {
    assert.strictEqual(roundtrip(true), true);
  });

  test('boolean false round-trips', (assert) => {
    assert.strictEqual(roundtrip(false), false);
  });

  test('integer round-trips', (assert) => {
    assert.strictEqual(roundtrip(42), 42);
  });

  test('negative integer round-trips', (assert) => {
    assert.strictEqual(roundtrip(-7), -7);
  });

  test('float round-trips', (assert) => {
    assert.strictEqual(roundtrip(3.14), 3.14);
  });

  test('zero round-trips', (assert) => {
    assert.strictEqual(roundtrip(0), 0);
  });
});

module('TAP | dumpYaml | strings', { concurrency: true }, () => {
  test('plain string round-trips', (assert) => {
    assert.strictEqual(roundtrip('hello world'), 'hello world');
  });

  test('empty string round-trips', (assert) => {
    assert.strictEqual(roundtrip(''), '');
  });

  test('YAML reserved word "null" is quoted', (assert) => {
    assert.strictEqual(roundtrip('null'), 'null');
  });

  test('YAML reserved word "true" is quoted', (assert) => {
    assert.strictEqual(roundtrip('true'), 'true');
  });

  test('YAML reserved word "false" is quoted', (assert) => {
    assert.strictEqual(roundtrip('false'), 'false');
  });

  test('YAML 1.1 boolean "yes" is quoted', (assert) => {
    assert.strictEqual(roundtrip('yes'), 'yes');
  });

  test('YAML 1.1 boolean "no" is quoted', (assert) => {
    assert.strictEqual(roundtrip('no'), 'no');
  });

  test('YAML 1.1 boolean "on" is quoted', (assert) => {
    assert.strictEqual(roundtrip('on'), 'on');
  });

  test('YAML 1.1 boolean "off" is quoted', (assert) => {
    assert.strictEqual(roundtrip('off'), 'off');
  });

  test('YAML 1.1 single-letter boolean "y" is quoted', (assert) => {
    assert.strictEqual(roundtrip('y'), 'y');
  });

  test('YAML 1.1 single-letter boolean "n" is quoted', (assert) => {
    assert.strictEqual(roundtrip('n'), 'n');
  });

  test('string starting with { is quoted', (assert) => {
    assert.strictEqual(roundtrip('{foo}'), '{foo}');
  });

  test('string starting with [ is quoted', (assert) => {
    assert.strictEqual(roundtrip('[1,2]'), '[1,2]');
  });

  test('string starting with # is quoted', (assert) => {
    assert.strictEqual(roundtrip('#comment'), '#comment');
  });

  test('string containing ": " is quoted', (assert) => {
    assert.strictEqual(roundtrip('key: value'), 'key: value');
  });

  test('string containing # is quoted', (assert) => {
    assert.strictEqual(roundtrip('foo#bar'), 'foo#bar');
  });

  test('numeric-looking string "123" is quoted', (assert) => {
    assert.strictEqual(roundtrip('123'), '123');
  });

  test('numeric-looking string "1.5" is quoted', (assert) => {
    assert.strictEqual(roundtrip('1.5'), '1.5');
  });

  test('document separator "---" is quoted', (assert) => {
    assert.strictEqual(roundtrip('---'), '---');
  });

  test('timestamp-like string is quoted', (assert) => {
    assert.strictEqual(roundtrip('2024-01-15'), '2024-01-15');
  });

  test('string with single quote is escaped', (assert) => {
    assert.strictEqual(roundtrip("it's"), "it's");
  });

  test('multiline string uses block scalar', (assert) => {
    const val = 'line1\nline2\nline3';
    assert.strictEqual(roundtrip(val), val);
  });

  test('multiline stack trace round-trips', (assert) => {
    const stack = 'Error: boom\n    at foo (file.js:1:1)\n    at bar (file.js:2:2)';
    assert.strictEqual(roundtrip(stack), stack);
  });

  test('string starting with whitespace is quoted to avoid ambiguous YAML spacing', (assert) => {
    assert.strictEqual(roundtrip('   leading spaces'), '   leading spaces');
    assert.strictEqual(roundtrip('\ttab indented'), '\ttab indented');
  });
});

module('TAP | dumpYaml | arrays', { concurrency: true }, () => {
  test('empty array round-trips', (assert) => {
    assert.deepEqual(roundtrip([]), []);
  });

  test('string array round-trips', (assert) => {
    assert.deepEqual(roundtrip(['a', 'b', 'c']), ['a', 'b', 'c']);
  });

  test('mixed array round-trips', (assert) => {
    assert.deepEqual(roundtrip([1, 'two', null, true]), [1, 'two', null, true]);
  });

  test('nested array round-trips', (assert) => {
    assert.deepEqual(
      roundtrip([
        [1, 2],
        [3, 4],
      ]),
      [
        [1, 2],
        [3, 4],
      ],
    );
  });

  test('no trailing space before array block', (assert) => {
    const out = dumpYaml({
      name: 'x',
      actual: ['a'],
      expected: null,
      message: null,
      stack: null,
      at: null,
    });
    assert.notIncludes(
      out,
      'actual: \n',
      'must not have "actual: \\n" — trailing space before block',
    );
  });

  test('array of objects round-trips', (assert) => {
    assert.deepEqual(roundtrip([{ a: 1 }, { b: 'two' }]), [{ a: 1 }, { b: 'two' }]);
  });

  test('no trailing space before array-of-objects block entries', (assert) => {
    const out = dumpYaml({
      name: 'x',
      actual: [{ key: 'val' }],
      expected: null,
      message: null,
      stack: null,
      at: null,
    });
    assert.notIncludes(out, '- \n', 'array entry must not have trailing space before object block');
  });
});

module('TAP | dumpYaml | objects', { concurrency: true }, () => {
  test('empty object round-trips', (assert) => {
    assert.deepEqual(roundtrip({}), {});
  });

  test('simple object round-trips', (assert) => {
    assert.deepEqual(roundtrip({ a: 1, b: 'hello' }), { a: 1, b: 'hello' });
  });

  test('nested object round-trips', (assert) => {
    assert.deepEqual(roundtrip({ x: { y: 42 } }), { x: { y: 42 } });
  });

  test('object with array value round-trips', (assert) => {
    assert.deepEqual(roundtrip({ items: [1, 2, 3] }), { items: [1, 2, 3] });
  });

  test('no trailing space before object block', (assert) => {
    const out = dumpYaml({
      name: 'x',
      actual: { k: 'v' },
      expected: null,
      message: null,
      stack: null,
      at: null,
    });
    assert.notIncludes(
      out,
      'actual: \n',
      'must not have "actual: \\n" — trailing space before block',
    );
  });
});

module('TAP | dumpYaml | full output structure', { concurrency: true }, () => {
  test('all 6 keys are present in output', (assert) => {
    const out = dumpYaml({
      name: 'Assertion #1',
      actual: false,
      expected: true,
      message: 'should be true',
      stack: 'Error\n    at test.js:5:3',
      at: 'test.js:5:3',
    });
    const parsed = load(out);
    assert.strictEqual(parsed.name, 'Assertion #1');
    assert.strictEqual(parsed.actual, false);
    assert.strictEqual(parsed.expected, true);
    assert.strictEqual(parsed.message, 'should be true');
    assert.true(parsed.stack.includes('Error'));
    assert.strictEqual(parsed.at, 'test.js:5:3');
  });

  test('null actual and expected are kept in output', (assert) => {
    const out = dumpYaml({
      name: 'x',
      actual: null,
      expected: null,
      message: null,
      stack: null,
      at: null,
    });
    const parsed = load(out);
    assert.strictEqual(parsed.actual, null, 'actual: null must always be emitted');
    assert.strictEqual(parsed.expected, null, 'expected: null must always be emitted');
  });

  test('null message, stack, and at are omitted from output', (assert) => {
    const out = dumpYaml({
      name: 'x',
      actual: false,
      expected: true,
      message: null,
      stack: null,
      at: null,
    });
    assert.notIncludes(out, 'message:', 'null message must not appear — it is just noise');
    assert.notIncludes(out, 'stack:', 'null stack must not appear — it is just noise');
    assert.notIncludes(out, 'at:', 'null at must not appear — it is just noise');
  });

  test('output ends with a single newline', (assert) => {
    const out = dumpYaml({
      name: 'x',
      actual: 1,
      expected: 2,
      message: null,
      stack: null,
      at: null,
    });
    assert.true(out.endsWith('\n'), 'output ends with newline');
    assert.false(out.endsWith('\n\n'), 'output does not end with double newline');
  });
});

// Roundtrip helper: our output must parse back to the same value via js-yaml
function roundtrip(value) {
  const out = dumpYaml({
    name: 'x',
    actual: value,
    expected: null,
    message: null,
    stack: null,
    at: null,
  });
  return load(out).actual;
}
