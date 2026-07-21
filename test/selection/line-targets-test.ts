import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as LineTargets from '../../lib/selection/line-targets.ts';

//  1 import { module, test } from 'qunitx';
//  2 (blank)
//  3 module('Outer', function () {
//  4   test('first', function (assert) {
//  5     assert.ok(true);
//  6   });
//  7 (blank)
//  8   module('Inner', function () {
//  9     test('nested', function (assert) {
// 10       assert.ok(true);
// 11     });
// 12   });
// 13 });
// 14 (blank)
// 15 test('loose', function (assert) {
// 16   assert.ok(true);
// 17 });
const SOURCE = [
  `import { module, test } from 'qunitx';`,
  ``,
  `module('Outer', function () {`,
  `  test('first', function (assert) {`,
  `    assert.ok(true);`,
  `  });`,
  ``,
  `  module('Inner', function () {`,
  `    test('nested', function (assert) {`,
  `      assert.ok(true);`,
  `    });`,
  `  });`,
  `});`,
  ``,
  `test('loose', function (assert) {`,
  `  assert.ok(true);`,
  `});`,
  ``,
].join('\n');

async function withFile<T>(source: string, fn: (filePath: string) => Promise<T>): Promise<T> {
  const filePath = path.join(os.tmpdir(), `qunitx-line-targets-${randomUUID()}.ts`);
  await fs.writeFile(filePath, source);
  try {
    return await fn(filePath);
  } finally {
    await fs.rm(filePath, { force: true });
  }
}

const resolve = (lines: number[], source = SOURCE) =>
  withFile(source, (filePath) => LineTargets.resolve(filePath, lines, 'a-test.ts'));

module('Utils | LineTargets.resolve | tests', { concurrency: true }, () => {
  test('a line on the test( line selects that test', async (assert) => {
    const { selectors } = await resolve([4]);
    assert.deepEqual(selectors, [{ module: 'Outer', test: 'first' }]);
  });

  test('a line inside the test body selects that test', async (assert) => {
    const { selectors } = await resolve([5]);
    assert.deepEqual(selectors, [{ module: 'Outer', test: 'first' }]);
  });

  test('a line on the closing }); of a test still selects it', async (assert) => {
    const { selectors } = await resolve([6]);
    assert.deepEqual(selectors, [{ module: 'Outer', test: 'first' }]);
  });

  test('the innermost declaration wins for a test nested two modules deep', async (assert) => {
    const { selectors } = await resolve([10]);
    assert.deepEqual(selectors, [{ module: 'Outer > Inner', test: 'nested' }]);
  });

  test('a top-level test resolves with an empty module path', async (assert) => {
    const { selectors } = await resolve([16]);
    assert.deepEqual(selectors, [{ module: '', test: 'loose' }]);
  });
});

module('Utils | LineTargets.resolve | modules', { concurrency: true }, () => {
  test('a line on a module( line selects the whole module', async (assert) => {
    const { selectors } = await resolve([3]);
    // No `test` key: the module and everything nested under it. Enumerating its tests instead
    // would silently drop any with a computed name.
    assert.deepEqual(selectors, [{ module: 'Outer' }]);
  });

  test('a line on a nested module( line selects that module by its full path', async (assert) => {
    const { selectors } = await resolve([8]);
    assert.deepEqual(selectors, [{ module: 'Outer > Inner' }]);
  });

  test('a blank line between tests inside a module selects the module', async (assert) => {
    const { selectors } = await resolve([7]);
    assert.deepEqual(selectors, [{ module: 'Outer' }]);
  });
});

module('Utils | LineTargets.resolve | degradation', { concurrency: true }, () => {
  test('a line outside every declaration runs the whole file with a warning', async (assert) => {
    const { selectors, warnings } = await resolve([1]);
    assert.strictEqual(selectors, null, 'null means run the file unfiltered');
    assert.deepEqual(warnings, ['no test or module found at a-test.ts#1 — running the whole file']);
  });

  test('a blank line between top-level declarations runs the whole file', async (assert) => {
    const { selectors } = await resolve([14]);
    assert.strictEqual(selectors, null);
  });

  test('a line past EOF runs the whole file', async (assert) => {
    const { selectors, warnings } = await resolve([9999]);
    assert.strictEqual(selectors, null);
    assert.equal(warnings.length, 1);
  });

  test('a computed test name degrades to its enclosing module', async (assert) => {
    const source = [
      `import { module, test } from 'qunitx';`,
      `module('M', function () {`,
      '  test(`case ${1}`, function (assert) {',
      `    assert.ok(true);`,
      `  });`,
      `});`,
    ].join('\n');
    const { selectors, warnings } = await resolve([4], source);

    assert.deepEqual(selectors, [{ module: 'M' }]);
    assert.deepEqual(warnings, [
      'the test at a-test.ts#4 has a computed name — running its module instead',
    ]);
  });

  test('a computed test name with no enclosing module runs the whole file', async (assert) => {
    const source = [
      `import { test } from 'qunitx';`,
      'test(`case ${1}`, function (assert) {',
      `  assert.ok(true);`,
      `});`,
    ].join('\n');
    const { selectors, warnings } = await resolve([3], source);

    assert.strictEqual(selectors, null);
    assert.ok(warnings[0].includes('computed name'), warnings[0]);
  });

  test('an unparseable file runs the whole file with a warning', async (assert) => {
    const { selectors, warnings } = await resolve([2], `import { test } from 'qunitx';\nconst = ;`);
    assert.strictEqual(selectors, null);
    assert.deepEqual(warnings, ['could not parse a-test.ts — running the whole file']);
  });

  test('a missing file runs the whole file with a warning', async (assert) => {
    const { selectors, warnings } = await LineTargets.resolve(
      '/nope/missing.ts',
      [1],
      'missing.ts',
    );
    assert.strictEqual(selectors, null);
    assert.deepEqual(warnings, ['could not read missing.ts — running the whole file']);
  });

  test('only() is called out, since QUnit then ignores every other test', async (assert) => {
    const source = [
      `import { only, test } from 'qunitx';`,
      `test('a', function (assert) {`,
      `  assert.ok(true);`,
      `});`,
      `only('b', function (assert) {`,
      `  assert.ok(true);`,
      `});`,
    ].join('\n');
    const { selectors, warnings } = await resolve([3], source);

    assert.deepEqual(selectors, [{ module: '', test: 'a' }]);
    assert.ok(warnings[0].includes('calls only()'), warnings[0]);
  });
});

module('Utils | LineTargets.resolve | multiple targets', { concurrency: true }, () => {
  test('several lines in one file union into several selectors', async (assert) => {
    const { selectors } = await resolve([5, 16]);
    assert.deepEqual(selectors, [
      { module: 'Outer', test: 'first' },
      { module: '', test: 'loose' },
    ]);
  });

  test('one unresolvable line among several runs the whole file', async (assert) => {
    // Anything less would silently drop the target the user could not have meant to lose.
    const { selectors } = await resolve([5, 1]);
    assert.strictEqual(selectors, null);
  });
});
