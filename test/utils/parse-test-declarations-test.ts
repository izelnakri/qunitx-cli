import { module, test } from 'qunitx';
import { parseTestDeclarations } from '../../lib/utils/parse-test-declarations.ts';

// filePath only picks the esbuild loader and names the sourcemap, so these can be fictional.
const TS = '/project/some-test.ts';

async function scan(source: string, filePath = TS) {
  return await parseTestDeclarations(source, filePath);
}

/** Compact `kind name start-end parent` rows — the whole shape of a scan in one string. */
async function rows(source: string, filePath = TS) {
  const result = await scan(source, filePath);
  if (!result) return 'NULL';

  return result.declarations
    .map((d) => `${d.kind} ${JSON.stringify(d.name)} ${d.startLine}-${d.endLine} p=${d.parent}`)
    .join('\n');
}

module('Utils | parseTestDeclarations | basics', { concurrency: true }, () => {
  test('finds a top-level test with its full line range', async (assert) => {
    assert.equal(
      await rows(
        `import { test } from 'qunitx';\ntest('a', function (assert) {\n  assert.ok(1);\n});\n`,
      ),
      `test "a" 2-4 p=null`,
    );
  });

  test('nests a test inside its module', async (assert) => {
    assert.equal(
      await rows(
        `import { module, test } from 'qunitx';\nmodule('M', function () {\n  test('a', function (assert) {\n    assert.ok(1);\n  });\n});\n`,
      ),
      [`module "M" 2-6 p=null`, `test "a" 3-5 p=0`].join('\n'),
    );
  });

  test('links a nested module chain', async (assert) => {
    const result = await scan(
      `import { module, test } from 'qunitx';\nmodule('Outer', function () {\n  module('Inner', function () {\n    test('a', function (assert) {\n      assert.ok(1);\n    });\n  });\n});\n`,
    );

    assert.deepEqual(
      result!.declarations.map((d) => d.parent),
      [null, 0, 1],
      'each declaration points at its innermost enclosing module',
    );
  });

  test('records test.skip and test.todo', async (assert) => {
    assert.equal(
      await rows(
        `import { test } from 'qunitx';\ntest.skip('s', function () {});\ntest.todo('t', function () {});\n`,
      ),
      [`test "s" 2-2 p=null`, `test "t" 3-3 p=null`].join('\n'),
    );
  });

  test('records bare only/skip/todo named imports', async (assert) => {
    const result = await scan(
      `import { only, skip, todo } from 'qunitx';\nonly('o', function () {});\nskip('s', function () {});\ntodo('t', function () {});\n`,
    );

    assert.deepEqual(
      result!.declarations.map((d) => d.name),
      ['o', 's', 't'],
    );
    assert.true(result!.hasOnly, 'only() gates every other test, so callers must be able to warn');
  });

  test('hasOnly is false without only()', async (assert) => {
    const result = await scan(`import { test } from 'qunitx';\ntest('a', function () {});\n`);
    assert.false(result!.hasOnly);
  });

  test('resolves aliased imports', async (assert) => {
    assert.equal(
      await rows(
        `import { module as m, test as t } from 'qunitx';\nm('M', function () {\n  t('a', function () {});\n});\n`,
      ),
      [`module "M" 2-4 p=null`, `test "a" 3-3 p=0`].join('\n'),
    );
  });

  test('resolves the default import as a namespace', async (assert) => {
    assert.equal(
      await rows(
        `import QUnit from 'qunitx';\nQUnit.module('M', function () {\n  QUnit.test('a', function () {});\n  QUnit.test.skip('b', function () {});\n});\n`,
      ),
      [`module "M" 2-5 p=null`, `test "a" 3-3 p=0`, `test "b" 4-4 p=0`].join('\n'),
    );
  });

  test('resolves a namespace import', async (assert) => {
    assert.equal(
      await rows(`import * as Q from 'qunitx';\nQ.test('a', function () {});\n`),
      `test "a" 2-2 p=null`,
    );
  });

  test('treats QUnit as a global namespace with no import', async (assert) => {
    assert.equal(await rows(`QUnit.test('a', function () {});\n`), `test "a" 1-1 p=null`);
  });
});

module('Utils | parseTestDeclarations | names', { concurrency: true }, () => {
  test('a template literal with no substitution is a literal name', async (assert) => {
    assert.equal(
      await rows(`import { test } from 'qunitx';\ntest(\`a b\`, function () {});\n`),
      `test "a b" 2-2 p=null`,
    );
  });

  test('a computed name is reported as null rather than guessed', async (assert) => {
    assert.equal(
      await rows(`import { test } from 'qunitx';\ntest(\`case \${1 + 1}\`, function () {});\n`),
      `test null 2-2 p=null`,
    );
  });

  test('a non-literal first argument is reported as null', async (assert) => {
    assert.equal(
      await rows(`import { test } from 'qunitx';\nconst n = 'x';\ntest(n, function () {});\n`),
      `test null 3-3 p=null`,
    );
  });

  test('escapes inside a name are cooked', async (assert) => {
    assert.equal(
      await rows(`import { test } from 'qunitx';\ntest('a\\'b', function () {});\n`),
      `test "a'b" 2-2 p=null`,
    );
  });

  test('an options object between name and callback does not shift the name', async (assert) => {
    assert.equal(
      await rows(
        `import { module } from 'qunitx';\nmodule('M', { concurrency: true }, function () {});\n`,
      ),
      `module "M" 2-2 p=null`,
    );
  });
});

module('Utils | parseTestDeclarations | lexing hazards', { concurrency: true }, () => {
  test('a test( inside a line comment is not a declaration', async (assert) => {
    assert.equal(
      await rows(
        `import { test } from 'qunitx';\n// test('commented', function () {\ntest('real', function () {});\n`,
      ),
      `test "real" 3-3 p=null`,
    );
  });

  test('a test( inside a block comment is not a declaration', async (assert) => {
    assert.equal(
      await rows(
        `import { test } from 'qunitx';\n/* test('commented', function () { */\ntest('real', function () {});\n`,
      ),
      `test "real" 3-3 p=null`,
    );
  });

  test('a test( inside a string literal is not a declaration', async (assert) => {
    assert.equal(
      await rows(
        `import { test } from 'qunitx';\ntest('real', function (assert) {\n  assert.equal("test('nope', 1)", 'x');\n});\n`,
      ),
      `test "real" 2-4 p=null`,
    );
  });

  test('a regex literal containing test( does not break the scan', async (assert) => {
    assert.equal(
      await rows(
        `import { test } from 'qunitx';\ntest('real', function (assert) {\n  assert.ok(/test\\(/.test('x'));\n});\n`,
      ),
      `test "real" 2-4 p=null`,
    );
  });

  test('division is not mistaken for a regex literal', async (assert) => {
    assert.equal(
      await rows(
        `import { test } from 'qunitx';\ntest('real', function (assert) {\n  const r = 10 / 2 / 5;\n  assert.ok(r);\n});\n`,
      ),
      `test "real" 2-5 p=null`,
    );
  });

  test('a template literal containing a backtick and a paren does not end early', async (assert) => {
    assert.equal(
      await rows(
        `import { test } from 'qunitx';\ntest('real', function (assert) {\n  const s = \`a \${\`nested )\`} b\`;\n  assert.ok(s);\n});\n`,
      ),
      `test "real" 2-5 p=null`,
    );
  });

  test('JSX text containing an apostrophe does not corrupt the scan', async (assert) => {
    // The reason the file is run through esbuild.transform before lexing: JSX text is not JS, so
    // a source-level lexer would open a string at "don't" and swallow everything after it.
    assert.equal(
      await rows(
        `import { test } from 'qunitx';\nfunction N() {\n  return <p title="don't stop">it's fine 50% / 2</p>;\n}\ntest('real', function (assert) {\n  assert.ok(N);\n});\n`,
        '/project/some-test.tsx',
      ),
      `test "real" 5-7 p=null`,
    );
  });

  test('TypeScript syntax does not corrupt the scan', async (assert) => {
    assert.equal(
      await rows(
        `import { test } from 'qunitx';\ntype A<T> = T extends string ? 1 : 2;\nconst x = <A<string>>1;\ntest('real', function (assert) {\n  assert.ok(x as unknown as boolean);\n});\n`,
      ),
      `test "real" 4-6 p=null`,
    );
  });
});

module('Utils | parseTestDeclarations | non-qunitx callees', { concurrency: true }, () => {
  test("a project's own module/skip helpers are not test declarations", async (assert) => {
    // Declarators are resolved from the qunitx import, not by name, so a local helper that
    // happens to be called `module` or `skip` cannot be mistaken for one.
    assert.equal(
      await rows(
        `import { test } from 'qunitx';\nfunction skip(n) { return n; }\nfunction module(n, fn) { return fn(n); }\nmodule('nope', function () {\n  skip('nope');\n});\ntest('real', function () {});\n`,
      ),
      `test "real" 7-7 p=null`,
    );
  });

  test('a member call on an unrelated object is not a declaration', async (assert) => {
    assert.equal(
      await rows(`import { test } from 'qunitx';\nfoo.test('nope', function () {});\n`),
      '',
      'foo.test is not the imported test',
    );
  });

  test('an import from another package is not a declarator', async (assert) => {
    assert.equal(
      await rows(`import { test } from 'node:test';\ntest('nope', function () {});\n`),
      '',
    );
  });
});

module('Utils | parseTestDeclarations | failure', { concurrency: true }, () => {
  test('a file that cannot be parsed returns null', async (assert) => {
    assert.strictEqual(
      await scan(`import { test } from 'qunitx';\ntest('a', function () {\n  const = ;\n});\n`),
      null,
      'callers fall back to running the whole file',
    );
  });

  test('a file with no declarations returns an empty list, not null', async (assert) => {
    const result = await scan(`export const a = 1;\n`);
    assert.deepEqual(result!.declarations, []);
  });
});
