import { module, test } from 'qunitx';
import { extractStackAt, failedAssertions, parseAt } from '../../lib/reporter/failure.ts';

module('reporters | extractStackAt', { concurrency: true }, () => {
  test('Chrome style: extracts clean URL without parens', (assert) => {
    const stack =
      '    at Object.<anonymous> (http://localhost:1234/tests.js:42:15)\n    at test (http://localhost:1234/tests.js:10:3)';
    assert.strictEqual(extractStackAt(stack), 'http://localhost:1234/tests.js:42:15');
  });

  test('Chrome style: strips file:// prefix from local paths', (assert) => {
    const stack = '    at Object.<anonymous> (file:///home/user/project/tests.js:42:15)';
    assert.strictEqual(extractStackAt(stack), '/home/user/project/tests.js:42:15');
  });

  test('Firefox/WebKit style: extracts URL after @', (assert) => {
    const stack =
      'Object.prototype.<anonymous>@http://localhost:1234/tests.js:42:15\n@http://localhost:1234/tests.js:10:3';
    assert.strictEqual(extractStackAt(stack), 'http://localhost:1234/tests.js:42:15');
  });

  test('returns null for null', (assert) => {
    assert.strictEqual(extractStackAt(null), null);
  });

  test('returns null for empty string', (assert) => {
    assert.strictEqual(extractStackAt(''), null);
  });

  test('returns null for plain error message with no location', (assert) => {
    assert.strictEqual(extractStackAt('Error: something went wrong'), null);
  });
});

module('reporters | parseAt', { concurrency: true }, () => {
  test('splits path:line:col', (assert) => {
    assert.deepEqual(parseAt('src/app.ts:12:5'), { file: 'src/app.ts', line: 12, col: 5 });
  });

  test('keeps colons inside the path (e.g. a URL with a port)', (assert) => {
    assert.deepEqual(parseAt('http://localhost:1234/tests.js:42:15'), {
      file: 'http://localhost:1234/tests.js',
      line: 42,
      col: 15,
    });
  });

  test('returns null for null or a non-location string', (assert) => {
    assert.strictEqual(parseAt(null), null);
    assert.strictEqual(parseAt('nope'), null);
  });
});

module('reporters | failedAssertions', { concurrency: true }, () => {
  test('returns only genuine failures, with 1-based indexes matching assertion order', (assert) => {
    const failures = failedAssertions({
      status: 'failed',
      fullName: ['m', 't'],
      runtime: 1,
      assertions: [
        { passed: true, todo: false, actual: 1, expected: 1 },
        { passed: false, todo: true, actual: 2, expected: 3 },
        { passed: false, todo: false, actual: 4, expected: 5, message: 'boom' },
      ],
    });
    assert.strictEqual(failures.length, 1, 'passing and todo assertions are excluded');
    assert.strictEqual(failures[0].index, 3, 'index reflects position in the original list');
    assert.strictEqual(failures[0].message, 'boom');
    assert.strictEqual(failures[0].actual, 4);
    assert.strictEqual(failures[0].expected, 5);
  });

  test('without a decoder, at falls back to the raw stack location', (assert) => {
    const failures = failedAssertions({
      status: 'failed',
      fullName: ['m', 't'],
      runtime: 1,
      assertions: [
        {
          passed: false,
          todo: false,
          actual: false,
          expected: true,
          stack: '    at Object.<anonymous> (http://localhost:1234/tests.js:42:15)',
        },
      ],
    });
    assert.strictEqual(failures[0].at, 'http://localhost:1234/tests.js:42:15');
    assert.strictEqual(failures[0].source, null, 'no source text without a decoder');
  });

  test('empty message becomes null rather than an empty string', (assert) => {
    const failures = failedAssertions({
      status: 'failed',
      fullName: ['m', 't'],
      runtime: 1,
      assertions: [{ passed: false, todo: false, actual: 1, expected: 2, message: '' }],
    });
    assert.strictEqual(failures[0].message, null);
  });

  test('circular actual/expected values are normalized rather than thrown on', (assert) => {
    const circular: Record<string, unknown> = { name: 'root' };
    circular.self = circular;
    const failures = failedAssertions({
      status: 'failed',
      fullName: ['m', 't'],
      runtime: 1,
      assertions: [{ passed: false, todo: false, actual: circular, expected: true }],
    });
    assert.deepEqual(
      failures[0].actual,
      { name: 'root', self: '[Circular]' },
      'circular refs collapse to [Circular]',
    );
  });

  test('a test with no assertions array yields no failures', (assert) => {
    assert.deepEqual(failedAssertions({ status: 'failed', fullName: ['m', 't'], runtime: 1 }), []);
  });
});
