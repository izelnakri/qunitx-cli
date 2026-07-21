import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { rmRetry } from '../helpers/rm-retry.ts';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import '../helpers/custom-asserts.ts';
import { execute as shell, shellFails, spawnCapture } from '../helpers/shell.ts';

const NESTED = 'test/fixtures/nested-module-tests.ts';
const CWD = process.cwd();

// Look declarations up by name so fixture edits (imports/blank lines) don't break the assertions.
const NESTED_SRC = (await fs.readFile(NESTED, 'utf8')).split('\n');
const lineOf = (needle: string) => NESTED_SRC.findIndex((line) => line.includes(needle)) + 1;

module('--search / --print', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('lists every test in QUnit registration format with a pasteable location', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED} --print`, { ...moduleMetadata, ...tm });

    // "Module > Sub: test name" is the exact string a filter matches against, and the location is
    // a `file#line` you can paste straight back in as a line target.
    assert.includes(result.stdout, 'Outer: outer first');
    assert.includes(result.stdout, 'Outer > Inner: inner only');
    assert.includes(result.stdout, `${NESTED}#${lineOf("test('outer first'")}`);
    assert.includes(result.stdout, '4 of 4 tests');
  });

  test('a file#line target scopes the preview exactly as a real run would', async (assert, tm) => {
    // The gap this closes: --print used to ignore line targets and list the whole file. It now
    // resolves them like a run — a test line lists one test, a module line lists the group.
    const test$ = await shell(`node cli.ts ${NESTED}#${lineOf("test('outer first'")} --print`, {
      ...moduleMetadata,
      ...tm,
    });
    assert.includes(test$.stdout, 'Outer: outer first');
    assert.includes(test$.stdout, '1 of 4 tests');

    const group$ = await shell(`node cli.ts ${NESTED}#${lineOf("module('Outer'")} --print`, {
      ...moduleMetadata,
      ...tm,
    });
    assert.includes(group$.stdout, '3 of 4 tests');
    assert.notIncludes(group$.stdout, 'separate one');
  });

  test('runs no tests at all — no TAP, no browser', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED} --print`, { ...moduleMetadata, ...tm });

    assert.notIncludes(result.stdout, 'TAP version 13');
    assert.notIncludes(result.stdout, 'ok 1');
    assert.notIncludes(result.stdout, '1..');
  });

  test('never pre-launches Chrome, so it leaks no user-data-dir', async (assert) => {
    // Regression: cli.ts statically imports chrome-prelaunch, which spawns Chrome for anything
    // that looks like a run command. --search finishes its static scan BEFORE Chrome's CDP is
    // ready, so shutdownPrelaunch() found no handle yet and returned without killing it —
    // orphaning both the process and its qunitx-chrome-* dir on every invocation.
    //
    // The run gets a private TMPDIR rather than snapshotting the shared one: the whole suite runs
    // concurrently and its other Chrome-spawning tests would otherwise land in the snapshot.
    const tmpdir = path.join(CWD, 'tmp', `search-tmpdir-${randomUUID()}`);
    await fs.mkdir(tmpdir, { recursive: true });
    try {
      await spawnCapture(`node ${CWD}/cli.ts ${NESTED} --print`, {
        env: { ...process.env, TMPDIR: tmpdir, TMP: tmpdir, TEMP: tmpdir, FORCE_COLOR: '0' },
        cwd: CWD,
      });
      const left = (await fs.readdir(tmpdir)).filter((e) => e.startsWith('qunitx-chrome-'));

      assert.deepEqual(left, [], 'a --print run must not leave a Chrome user-data-dir behind');
    } finally {
      await rmRetry(tmpdir);
    }
  });

  test('-s <expression> narrows the listing', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED} -s inner`, { ...moduleMetadata, ...tm });

    assert.includes(result.stdout, 'Outer > Inner: inner only');
    assert.notIncludes(result.stdout, 'outer first');
    assert.includes(result.stdout, '1 of 4 tests match "inner"');
  });

  test('all four spellings list the same thing', async (assert, tm) => {
    const outputs = await Promise.all(
      ['--search=inner', '-s=inner', '--print=inner', '--preview=inner'].map(async (flag) => {
        const result = await shell(`node cli.ts ${NESTED} ${flag}`, { ...moduleMetadata, ...tm });
        return result.stdout;
      }),
    );

    assert.equal(new Set(outputs).size, 1, '--search, -s, --print and --preview are one flag');
  });

  test('a file whose declarator is a local alias is reported, not silently dropped', async (assert, tm) => {
    // `var t = QUnit.test` is invisible to the static scan (declarators resolve from the qunitx
    // import and the QUnit global only). Previously such a file just vanished from the count; the
    // listing must say it saw nothing rather than under-report.
    const dir = await fs.mkdtemp(path.join(CWD, 'tmp', 'qunitx-alias-'));
    await fs.writeFile(
      path.join(dir, 'alias-test.ts'),
      `import QUnit from 'qunitx';\n` +
        `var t = QUnit.test;\n` +
        `t('hidden by alias', function (assert) { assert.ok(true); });\n`,
    );
    try {
      const result = await shellFails(`node cli.ts ${dir} --print`, { ...moduleMetadata, ...tm });

      assert.includes(result.stdout, '0 of 0 tests');
      assert.includes(result.stdout, 'declared no tests the scan could see');
      assert.includes(result.stdout, 'local alias');
    } finally {
      await rmRetry(dir);
    }
  });

  test('the preview matches what an actual run selects', async (assert, tm) => {
    // The whole promise of --search: what it lists is what -t would run. A drifting matcher would
    // make the preview a lie, so this pins them together end to end.
    const preview = await shell(`node cli.ts ${NESTED} -s inner`, { ...moduleMetadata, ...tm });
    const run = await shell(`node cli.ts ${NESTED} -t inner`, { ...moduleMetadata, ...tm });

    assert.includes(preview.stdout, '1 of 4 tests match');
    assert.tapResult(run, { testCount: 1 });
    assert.includes(run.stdout, 'Outer | Inner | inner only');
  });

  test('a bare -s previews the -t expression rather than everything', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED} -t inner -s`, { ...moduleMetadata, ...tm });

    assert.includes(result.stdout, '1 of 4 tests match "inner"');
  });

  test('matching nothing exits 1, like grep', async (assert, tm) => {
    const error = await shellFails(`node cli.ts ${NESTED} -s nothing-matches-this`, {
      ...moduleMetadata,
      ...tm,
    });

    assert.equal(error.code, 1);
    assert.includes(error.stdout, '0 of 4 tests match "nothing-matches-this"');
  });

  test('a regex expression previews the exact-module recipe', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED} '-s=/^Outer(:| >)/'`, {
      ...moduleMetadata,
      ...tm,
    });

    assert.includes(result.stdout, '3 of 4 tests match');
    assert.notIncludes(result.stdout, 'separate one');
  });
});
