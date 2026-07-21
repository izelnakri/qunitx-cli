import { module, test } from 'qunitx';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { rmRetry } from '../helpers/rm-retry.ts';
import os from 'node:os';
import path from 'node:path';
import '../helpers/custom-asserts.ts';
import { execute as shell, shellWatch } from '../helpers/shell.ts';

const NESTED = 'test/fixtures/nested-module-tests.ts';

// Declarations are looked up BY NAME, not by hard-coded line number, so the fixture can gain
// imports or blank lines without breaking these tests. `lineOf` returns the 1-based line of the
// first source line containing the needle.
const SRC = (await readFile(NESTED, 'utf8')).split('\n');
const lineOf = (needle: string) => SRC.findIndex((line) => line.includes(needle)) + 1;
const OUTER = lineOf("module('Outer'");
const OUTER_FIRST = lineOf("test('outer first'");
const OUTER_SECOND_BODY = lineOf("test('outer second'") + 1; // a line inside the test body
const INNER = lineOf("module('Inner'");
const SEPARATE_ONE = lineOf("test('separate one'");
const IMPORT_LINE = lineOf("from 'qunitx'"); // outside every declaration

module('file#line targeting', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('#N on a test( line runs only that test', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED}#${OUTER_FIRST}`, {
      ...moduleMetadata,
      ...tm,
    });

    assert.tapResult(result, { testCount: 1 });
    assert.includes(result.stdout, 'Outer | outer first');
  });

  test('#N inside a test body runs only that test', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED}#${OUTER_SECOND_BODY}`, {
      ...moduleMetadata,
      ...tm,
    });

    assert.tapResult(result, { testCount: 1 });
    assert.includes(result.stdout, 'Outer | outer second');
  });

  test(':N is accepted as an alias for #N', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED}:${OUTER_FIRST}`, {
      ...moduleMetadata,
      ...tm,
    });

    assert.tapResult(result, { testCount: 1 });
    assert.includes(result.stdout, 'Outer | outer first');
  });

  test('#N on a nested module( line runs that module', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED}#${INNER}`, { ...moduleMetadata, ...tm });

    assert.tapResult(result, { testCount: 1 });
    assert.includes(result.stdout, 'Outer | Inner | inner only');
  });

  test('#N on an outer module( line runs the module and its nested children', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED}#${OUTER}`, { ...moduleMetadata, ...tm });

    assert.tapResult(result, { testCount: 3 });
    assert.includes(result.stdout, 'Outer | Inner | inner only');
    assert.notIncludes(result.stdout, 'separate one');
  });

  test('two line targets on one file run both tests', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED}#${OUTER_FIRST} ${NESTED}#${SEPARATE_ONE}`, {
      ...moduleMetadata,
      ...tm,
    });

    assert.tapResult(result, { testCount: 2 });
    assert.includes(result.stdout, 'outer first');
    assert.includes(result.stdout, 'separate one');
  });

  test('a line target scopes only its own file; a plain input still runs whole', async (assert, tm) => {
    const result = await shell(
      `node cli.ts ${NESTED}#${OUTER_FIRST} test/fixtures/passing-tests.ts`,
      { ...moduleMetadata, ...tm },
    );

    // The whole point of running each line-targeted file as its own group: one page has one
    // QUnit config, so a shared page could not scope one file without scoping the other.
    assert.tapResult(result, { testCount: 4 });
    assert.includes(result.stdout, 'Outer | outer first');
    assert.includes(result.stdout, 'deepEqual true works');
    assert.notIncludes(result.stdout, 'outer second');
  });

  test('an unresolvable line warns and runs the whole file', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED}#${IMPORT_LINE}`, {
      ...moduleMetadata,
      ...tm,
    });

    assert.includes(
      result.stdout,
      `# qunitx: no test or module found at ${NESTED}#${IMPORT_LINE} — running the whole file`,
    );
    assert.tapResult(result, { testCount: 4 });
  });

  test('a line target composes with -t', async (assert, tm) => {
    // testFilter is ANDed after filter, so a -t that excludes the targeted test yields nothing.
    const result = await shell(`node cli.ts ${NESTED}#${OUTER} -t 'second'`, {
      ...moduleMetadata,
      ...tm,
    });

    assert.tapResult(result, { testCount: 1 });
    assert.includes(result.stdout, 'outer second');
  });

  test('a line-targeted run leaves the failure cache alone', async (assert, tm) => {
    // Same reasoning as -t: the run saw one test, so its failure set is not the file's.
    const result = await shell(`node cli.ts ${NESTED}#${OUTER_FIRST} --debug`, {
      ...moduleMetadata,
      ...tm,
    });

    assert.tapResult(result, { testCount: 1 });
  });

  test('a broader input supersedes a line target on a file it already includes whole', async (assert, tm) => {
    // `dir file#N` where the dir contains the file: the dir is a "run everything here" gesture, so
    // it wins and the file runs whole — the line target would otherwise silently run fewer tests
    // than asked. Announced, not dropped silently. Checked via --print (static, no browser).
    const dir = await mkdtemp(path.join(os.tmpdir(), 'qunitx-supersede-'));
    await writeFile(
      path.join(dir, 'x-test.ts'),
      `import { module, test } from 'qunitx';\n` +
        `module('X', function () {\n` +
        `  test('x1', function (assert) { assert.ok(true); });\n` +
        `  test('x2', function (assert) { assert.ok(true); });\n` +
        `});\n`,
    );
    try {
      const out = await shell(`node cli.ts ${dir} ${dir}/x-test.ts#3 --print`, {
        ...moduleMetadata,
        ...tm,
      });

      assert.includes(out.stdout, 'X: x1');
      assert.includes(out.stdout, 'X: x2', 'the whole file runs, not just line 3');
      assert.includes(out.stdout, '2 of 2 tests');
      assert.includes(out.stdout, 'line target ignored');
    } finally {
      await rmRetry(dir);
    }
  });

  test('the same file given both whole and line-targeted runs whole', async (assert, tm) => {
    // `a.ts a.ts#34` — the two mentions collapse in the input Set, so this exact-path case is
    // caught via the parser's whole-input tracking, not the directory/glob coverage check.
    const out = await shell(`node cli.ts ${NESTED} ${NESTED}#${OUTER_FIRST} --print`, {
      ...moduleMetadata,
      ...tm,
    });

    assert.includes(out.stdout, '4 of 4 tests', 'the whole file wins over the line target');
    assert.includes(out.stdout, 'line target ignored');
  });
});

module('file#line targeting in watch mode', { concurrency: true }, () => {
  test('--watch with a line target scopes the session and says what it dropped', async (assert) => {
    const stdout = await shellWatch(
      `node cli.ts ${NESTED}#${OUTER_FIRST} test/fixtures/passing-tests.ts --watch`,
      { until: (buf) => buf.includes('Press "qq"') },
    );

    // Watch is one page with one QUnit config, so the untargeted file cannot be left unscoped
    // the way concurrent mode manages. It is dropped and named rather than silently loaded.
    assert.includes(stdout, 'runs only the targeted file');
    assert.includes(stdout, '1 other file excluded');
    assert.includes(stdout, 'press "qa" to run every test');
    assert.includes(stdout, 'ok 1 Outer | outer first');
    assert.includes(stdout, '1..1');
  });
});
