import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { rmRetry } from '../helpers/rm-retry.ts';
import { randomUUID } from 'node:crypto';
import '../helpers/custom-asserts.ts';
import { execute as shell, shellFails } from '../helpers/shell.ts';

const NESTED = 'test/fixtures/nested-module-tests.ts';
const CWD = process.cwd();

module('Flags | --filter', { concurrency: true }, (_hooks, moduleMetadata) => {
  // Matching semantics — case-insensitivity, /regex/ and /regex/i, the ! inversion, the
  // module path counting toward a match — belong to Selection | matchQUnitFilter, and the
  // flag spellings to Args | parse | -t / --filter. What can only be proven with a real
  // browser is that the expression reaches QUnit at all, against the fullName QUnit itself
  // builds. These tests own that seam and nothing else.
  test('-t reaches the browser and selects only the matching test', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED} -t 'outer first'`, {
      ...moduleMetadata,
      ...tm,
    });

    assert.tapResult(result, { testCount: 1 });
    assert.includes(result.stdout, 'Outer | outer first');
  });

  test('a /regex/ filter is applied to QUnit\'s own "Module: test name" fullName', async (assert, tm) => {
    // The anchors are the point: they only line up if the browser-side fullName has the
    // exact shape buildQUnitFullName encodes. A substring filter would pass either way.
    const result = await shell(`node cli.ts ${NESTED} -t '/^Outer: outer (first|second)$/'`, {
      ...moduleMetadata,
      ...tm,
    });

    assert.tapResult(result, { testCount: 2 });
    assert.notIncludes(
      result.stdout,
      'inner only',
      'the anchored regex excludes the nested Inner test',
    );
  });

  test('a filter matching nothing exits 1 with a plan of 0 and no synthetic failure', async (assert, tm) => {
    const error = await shellFails(`node cli.ts ${NESTED} -t 'nothing-matches-this'`, {
      ...moduleMetadata,
      ...tm,
    });

    assert.equal(error.code, 1, 'a mistyped filter must not pass CI');
    assert.includes(error.stdout, '# No tests matched --filter=nothing-matches-this');
    assert.includes(error.stdout, '1..0');
    // QUnit's failOnZeroTests would synthesize a "global failure" test per group. Under a
    // filter most groups legitimately match nothing, so it must be off.
    assert.notIncludes(error.stdout, 'global failure');
    assert.notIncludes(error.stdout, 'No tests matched the filter');
    assert.notIncludes(error.stdout, 'not ok');
  });

  test('a filter spanning several files runs them concurrently without empty-group failures', async (assert, tm) => {
    const result = await shell(
      `node cli.ts test/fixtures/passing-tests.ts test/fixtures/passing-tests.js ${NESTED} -t 'deepEqual'`,
      { ...moduleMetadata, ...tm },
    );

    // Only the two passing-tests files hold a deepEqual test; the nested fixture's group
    // matches nothing and must contribute neither a test nor a failure.
    assert.tapResult(result, { testCount: 2, failCount: 0 });
    assert.includes(result.stdout, 'across 3 groups');
    assert.notIncludes(result.stdout, 'not ok');
  });

  test('-m selects a module by its own name or its full path, nested children included', async (assert, tm) => {
    // QUnit's own config.module cannot do the second one: it compares the JOINED chain path,
    // so "Inner" matches nothing. Routing every spelling through config.filter is what fixes
    // it, and only a real run can show QUnit accepted the routing.
    const [outer, inner] = await Promise.all([
      shell(`node cli.ts ${NESTED} -m Outer`, { ...moduleMetadata, ...tm }),
      shell(`node cli.ts ${NESTED} -m Inner`, { ...moduleMetadata, ...tm }),
    ]);

    assert.tapResult(outer, { testCount: 3 });
    assert.includes(outer.stdout, 'Outer | Inner | inner only', 'nested children come along');
    assert.notIncludes(outer.stdout, 'separate one');

    assert.tapResult(inner, { testCount: 1 });
    assert.includes(inner.stdout, 'Outer | Inner | inner only');
  });
});

module('Flags | --filter | persistent caches', { concurrency: true }, () => {
  test('a filtered run writes neither the timing nor the failure cache', async (assert) => {
    // Both caches live at a fixed `tmp/` path relative to the project root, so this test runs
    // in its own project dir rather than racing the suite's real caches.
    const id = randomUUID();
    const project = `${CWD}/tmp/filter-cache-${id}`;
    await fs.mkdir(`${project}/tmp`, { recursive: true });
    // A package.json is what makes this a project: findProjectRoot walks up until it finds one,
    // so without it both caches would resolve to the repo's own tmp/ and race the whole suite.
    // A self-contained test file (no external imports) keeps this decoupled from the shared
    // fixtures — the test only needs *some* tests to run, filtered and unfiltered.
    await Promise.all([
      fs.symlink(`${CWD}/node_modules`, `${project}/node_modules`).catch(() => {}),
      fs.writeFile(
        `${project}/package.json`,
        JSON.stringify({ name: id, version: '0.0.1', type: 'module' }),
      ),
      fs.writeFile(
        `${project}/cache-test.ts`,
        `import { module, test } from 'qunitx';\n` +
          `module('Cache', function () {\n` +
          `  test('kept', function (assert) { assert.ok(true); });\n` +
          `  test('other', function (assert) { assert.ok(true); });\n` +
          `});\n`,
      ),
    ]);

    try {
      // An unfiltered run establishes both caches...
      await runInProject(project, 'cache-test.ts');
      const timingsBefore = await fs.readFile(`${project}/tmp/test-timings.json`, 'utf8');
      const failuresBefore = await fs.readFile(`${project}/tmp/.qunitx-last-failures.json`, 'utf8');

      // ...and a filtered run must leave both exactly as they were. It sees only a subset of
      // each file's tests: its wall time would mis-pack every future run's groups, and its
      // failure set would silently shrink what the next --only-failed re-runs.
      await runInProject(project, `cache-test.ts -t 'kept'`);

      assert.equal(
        await fs.readFile(`${project}/tmp/test-timings.json`, 'utf8'),
        timingsBefore,
        'a filtered run must not persist timings',
      );
      assert.equal(
        await fs.readFile(`${project}/tmp/.qunitx-last-failures.json`, 'utf8'),
        failuresBefore,
        'a filtered run must not rewrite the failure cache',
      );
    } finally {
      await rmRetry(project);
    }
  });
});

function runInProject(cwd: string, args: string) {
  return shell(`node ${CWD}/cli.ts ${args}`, { cwd });
}
