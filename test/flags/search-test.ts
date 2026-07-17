import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import '../helpers/custom-asserts.ts';
import shell, { shellFails, spawnCapture } from '../helpers/shell.ts';

const NESTED = 'test/fixtures/nested-module-tests.ts';
const CWD = process.cwd();

module('--search / --print', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('lists every test in QUnit registration format with a pasteable location', async (assert, tm) => {
    const result = await shell(`node cli.ts ${NESTED} --print`, { ...moduleMetadata, ...tm });

    // "Module > Sub: test name" is the exact string a filter matches against, and the location is
    // a `file#line` you can paste straight back in as a line target.
    assert.includes(result.stdout, 'Outer: outer first');
    assert.includes(result.stdout, 'Outer > Inner: inner only');
    assert.includes(result.stdout, `${NESTED}#8`);
    assert.includes(result.stdout, '4 of 4 tests');
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
      await fs.rm(tmpdir, { recursive: true, force: true });
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
      ['--search=inner', '-s=inner', '--print=inner', '-p=inner'].map(async (flag) => {
        const result = await shell(`node cli.ts ${NESTED} ${flag}`, { ...moduleMetadata, ...tm });
        return result.stdout;
      }),
    );

    assert.equal(new Set(outputs).size, 1, '--search, -s, --print and -p are one flag');
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
