import { module, test } from 'qunitx';
import { tokenizeArgs } from '../../lib/utils/tokenize-args.ts';

module('Utils | tokenizeArgs | flags and inputs', { concurrency: true }, () => {
  test('a plain flag passes through verbatim', (assert) => {
    assert.deepEqual(tokenizeArgs(['--watch']), [{ kind: 'flag', raw: '--watch' }]);
  });

  test('a flag with a glued value keeps it on raw', (assert) => {
    assert.deepEqual(tokenizeArgs(['--timeout=5000']), [{ kind: 'flag', raw: '--timeout=5000' }]);
  });

  test('a positional entry is an input', (assert) => {
    assert.deepEqual(tokenizeArgs(['test/foo.ts']), [{ kind: 'input', raw: 'test/foo.ts' }]);
  });

  test('a lone dash is an input, not a flag', (assert) => {
    assert.deepEqual(tokenizeArgs(['-']), [{ kind: 'input', raw: '-' }]);
  });

  test('an input named like an Object prototype key is not misread as a query flag', (assert) => {
    // Regression: the flag lookup used to be a plain object, so `__proto__`/`constructor` resolved
    // to a truthy prototype value and were classified as query flags. A Map has no such keys.
    assert.deepEqual(tokenizeArgs(['constructor', '__proto__']), [
      { kind: 'input', raw: 'constructor' },
      { kind: 'input', raw: '__proto__' },
    ]);
  });
});

module('Utils | tokenizeArgs | query flags', { concurrency: true }, () => {
  test('a glued value is a single non-greedy token', (assert) => {
    assert.deepEqual(tokenizeArgs(['--filter=adds']), [
      { kind: 'query', key: 'run', value: 'adds', greedy: false },
    ]);
  });

  test('-t=value keeps everything after the first = (regex with its own =)', (assert) => {
    assert.deepEqual(tokenizeArgs(['-t=/a=b/i']), [
      { kind: 'query', key: 'run', value: '/a=b/i', greedy: false },
    ]);
  });

  test('a bare -t greedily joins following words into the value', (assert) => {
    assert.deepEqual(tokenizeArgs(['-t', 'Some', 'Module', 'loading', 'tests']), [
      { kind: 'query', key: 'run', value: 'Some Module loading tests', greedy: true },
    ]);
  });

  test('greedy consumption stops at the next flag', (assert) => {
    assert.deepEqual(tokenizeArgs(['-m', 'Some', 'Module', '--junit', '--reporter=spec']), [
      { kind: 'query', key: 'run', value: 'Some Module', greedy: true },
      { kind: 'flag', raw: '--junit' },
      { kind: 'flag', raw: '--reporter=spec' },
    ]);
  });

  test('-m/--module are spellings of the same filter key as -t/--filter', (assert) => {
    const spellings = ['-t', '--filter', '-m', '--module'].map(
      (flag) => tokenizeArgs([flag, 'Cart'])[0],
    );
    assert.deepEqual(
      spellings,
      Array(4).fill({ kind: 'query', key: 'run', value: 'Cart', greedy: true }),
    );
  });

  test('-s/--search/-p/--print are spellings of the search key', (assert) => {
    const spellings = ['-s', '--search', '-p', '--print'].map(
      (flag) => tokenizeArgs([flag, 'Cart'])[0],
    );
    assert.deepEqual(
      spellings,
      Array(4).fill({ kind: 'query', key: 'list', value: 'Cart', greedy: true }),
    );
  });

  test('a bare --print yields a null value (list everything)', (assert) => {
    assert.deepEqual(tokenizeArgs(['--print']), [
      { kind: 'query', key: 'list', value: null, greedy: true },
    ]);
  });

  test('an inverted single-word filter is captured (! is not a flag)', (assert) => {
    assert.deepEqual(tokenizeArgs(['-t', '!slow']), [
      { kind: 'query', key: 'run', value: '!slow', greedy: true },
    ]);
  });

  test('a bare -t with nothing after it yields a null value', (assert) => {
    assert.deepEqual(tokenizeArgs(['-t']), [
      { kind: 'query', key: 'run', value: null, greedy: true },
    ]);
  });

  test('a bare -t immediately before another flag yields a null value', (assert) => {
    assert.deepEqual(tokenizeArgs(['-t', '--watch']), [
      { kind: 'query', key: 'run', value: null, greedy: true },
      { kind: 'flag', raw: '--watch' },
    ]);
  });

  test('two query flags in a row each take their own value', (assert) => {
    // -m and -t are the same key now, so the parser resolves the clash (last wins + a warning);
    // the tokenizer's job is only to keep the two values apart.
    assert.deepEqual(tokenizeArgs(['-m', 'Cart', '-t', 'adds to cart']), [
      { kind: 'query', key: 'run', value: 'Cart', greedy: true },
      { kind: 'query', key: 'run', value: 'adds to cart', greedy: true },
    ]);
  });

  test('a filter and a search expression are separate keys', (assert) => {
    assert.deepEqual(tokenizeArgs(['-t', 'Cart', '-s', 'Coupons']), [
      { kind: 'query', key: 'run', value: 'Cart', greedy: true },
      { kind: 'query', key: 'list', value: 'Coupons', greedy: true },
    ]);
  });
});

module('Utils | tokenizeArgs | ordering and --', { concurrency: true }, () => {
  test('inputs before a query flag stay inputs; the value is everything after', (assert) => {
    assert.deepEqual(tokenizeArgs(['test/a', 'test/b', '-m', 'Some Module']), [
      { kind: 'input', raw: 'test/a' },
      { kind: 'input', raw: 'test/b' },
      { kind: 'query', key: 'run', value: 'Some Module', greedy: true },
    ]);
  });

  test('a bare query flag swallows following inputs (the ordering footgun)', (assert) => {
    // This is the documented cost of greedy parsing: `test/foo` lands in the value. `--` or
    // putting targets first is the escape hatch, exercised below.
    assert.deepEqual(tokenizeArgs(['-t', 'foo', 'test/foo']), [
      { kind: 'query', key: 'run', value: 'foo test/foo', greedy: true },
    ]);
  });

  test('-- ends option parsing: everything after is an input', (assert) => {
    assert.deepEqual(tokenizeArgs(['-t', 'foo', '--', 'test/foo', '--weird']), [
      { kind: 'query', key: 'run', value: 'foo', greedy: true },
      { kind: 'input', raw: 'test/foo' },
      { kind: 'input', raw: '--weird' },
    ]);
  });

  test('greedy consumption halts at -- without swallowing it', (assert) => {
    assert.deepEqual(tokenizeArgs(['-m', 'Cart', '--', 'test/']), [
      { kind: 'query', key: 'run', value: 'Cart', greedy: true },
      { kind: 'input', raw: 'test/' },
    ]);
  });
});
