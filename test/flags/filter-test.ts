import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import '../helpers/custom-asserts.ts';
import shell, { shellFails, spawnCapture } from '../helpers/shell.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';

const NESTED = 'test/fixtures/nested-module-tests.ts';
const CWD = process.cwd();

module('--filter / -t flag tests', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('-t narrows to the matching test by case-insensitive substring', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED} -t 'outer first'`, {
      ...moduleMetadata,
      ...tm,
    });

    assert.tapResult(result, { testCount: 1 });
    assert.includes(result.stdout, 'Outer | outer first');
  });

  test('--filter=<pattern> is equivalent to -t', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED} --filter='outer first'`, {
      ...moduleMetadata,
      ...tm,
    });

    assert.tapResult(result, { testCount: 1 });
  });

  test('the match is case-insensitive', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED} -t 'OUTER FIRST'`, {
      ...moduleMetadata,
      ...tm,
    });

    assert.tapResult(result, { testCount: 1 });
  });

  test('a /regex/ filter matches against "Module: test name"', async (assert, tm) => {
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

  test('a /regex/i filter honours the i flag', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED} -t '/OUTER FIRST/i'`, {
      ...moduleMetadata,
      ...tm,
    });

    assert.tapResult(result, { testCount: 1 });
  });

  test('a ! prefix inverts the filter', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED} -t '!outer'`, { ...moduleMetadata, ...tm });

    // The filter matches "Module: test name", so !outer also drops "Outer > Inner: inner only" —
    // the module path counts, not just the test name. Only Separate survives.
    assert.tapResult(result, { testCount: 1 });
    assert.includes(result.stdout, 'separate one');
    assert.notIncludes(result.stdout, 'outer first');
  });

  test('a filter matching nothing exits 1 with a clear message', async (assert, tm) => {
    const error = await shellFails(`node cli.ts ${NESTED} -t 'nothing-matches-this'`, {
      ...moduleMetadata,
      ...tm,
    });

    assert.equal(error.code, 1, 'a mistyped filter must not pass CI');
    assert.includes(error.stdout, '# No tests matched --filter=nothing-matches-this');
    assert.includes(error.stdout, '1..0');
  });

  test('a filter matching nothing emits no synthetic QUnit failure', async (assert, tm) => {
    const error = await shellFails(`node cli.ts ${NESTED} -t 'nothing-matches-this'`, {
      ...moduleMetadata,
      ...tm,
    });

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

  test('-t after -m overrides it (one flag) and says so', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED} -m Outer -t 'second'`, {
      ...moduleMetadata,
      ...tm,
    });

    // They do not compose — -m and -t are the same flag, so the last expression wins. The run
    // is "second", not "Outer AND second"; the warning is what keeps that from being silent.
    assert.tapResult(result, { testCount: 1 });
    assert.includes(result.stdout, 'outer second');
    assert.includes(result.stderr, 'the test filter was given more than once');
  });
});

module(
  '-m / --module are spellings of --filter',
  { concurrency: true },
  (_hooks, moduleMetadata) => {
    test('-m selects a module and its nested children', async (assert, tm) => {
      const result = await shell(`node cli.ts ${NESTED} -m Outer`, { ...moduleMetadata, ...tm });

      assert.tapResult(result, { testCount: 3 });
      assert.includes(result.stdout, 'Outer | Inner | inner only');
      assert.notIncludes(result.stdout, 'separate one');
    });

    test('-m matches a nested module by its full " > " path', async (assert, tm) => {
      const result = await shell(`node cli.ts ${NESTED} -m 'Outer > Inner'`, {
        ...moduleMetadata,
        ...tm,
      });

      assert.tapResult(result, { testCount: 1 });
      assert.includes(result.stdout, 'inner only');
    });

    test('-m finds a nested module by its own name — no full path needed', async (assert, tm) => {
      // QUnit's own config.module cannot do this: it compares the JOINED chain path, so "Inner"
      // matches nothing. Routing every spelling through config.filter is what fixes it.
      const result = await shell(`node cli.ts ${NESTED} -m Inner`, { ...moduleMetadata, ...tm });

      assert.tapResult(result, { testCount: 1 });
      assert.includes(result.stdout, 'Outer | Inner | inner only');
    });

    test('-m matches a prefix, because it is the same substring matcher as -t', async (assert, tm) => {
      const result = await shell(`node cli.ts ${NESTED} -m Out`, { ...moduleMetadata, ...tm });

      assert.tapResult(result, { testCount: 3 });
      assert.includes(result.stdout, 'outer first', 'exact-match semantics are gone by design');
    });

    test('-m and -t are interchangeable', async (assert, tm) => {
      const viaModule = await shell(`node cli.ts ${NESTED} -m Inner`, { ...moduleMetadata, ...tm });
      const viaFilter = await shell(`node cli.ts ${NESTED} -t Inner`, { ...moduleMetadata, ...tm });
      // The contract is "the same tests are selected", so compare the selected names — not raw
      // stdout, whose timings, port and blank-line flushing all vary between two live runs.
      const selected = (out: string) =>
        out
          .split('\n')
          .filter((line) => line.startsWith('ok ') || line.startsWith('not ok '))
          .map((line) => line.replace(/ # \(.*/, ''));

      assert.deepEqual(selected(viaModule.stdout), selected(viaFilter.stdout), 'one matcher');
      assert.deepEqual(selected(viaModule.stdout), ['ok 1 Outer | Inner | inner only']);
    });

    test('the exact-module recipe still isolates one module', async (assert, tm) => {
      // The documented stand-in for the exact matching -m used to do.
      const result = await shell(`node cli.ts ${NESTED} '-m=/^Outer(:| >)/'`, {
        ...moduleMetadata,
        ...tm,
      });

      assert.tapResult(result, { testCount: 3 });
      assert.notIncludes(result.stdout, 'separate one');
    });

    test('-m is case-insensitive', async (assert, tm) => {
      const result = await shell(`node cli.ts ${NESTED} -m 'oUtEr'`, { ...moduleMetadata, ...tm });

      assert.tapResult(result, { testCount: 3 });
    });
  },
);

module('filtered runs and the persistent caches', { concurrency: true }, () => {
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
      await fs.rm(project, { recursive: true, force: true });
    }
  });
});

// The default `shell` export has no cwd option, so cwd-scoped runs go through spawnCapture
// directly — which means hand-rolling the --output flag and the browser permit it would add.
async function runInProject(cwd: string, args: string) {
  const permit = await acquireBrowser();
  try {
    return await spawnCapture(`node ${CWD}/cli.ts ${args} --output=tmp/run-${randomUUID()}`, {
      env: { ...process.env, FORCE_COLOR: '0' },
      cwd,
    });
  } finally {
    permit.release();
  }
}
