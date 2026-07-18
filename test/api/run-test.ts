import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import '../helpers/custom-asserts.ts';
import { run, search } from '../../lib/api/index.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import { spawnCapture } from '../helpers/shell.ts';

const PASSING = 'test/helpers/passing-tests.js';
const API_ENTRY = pathToFileURL(path.resolve('lib/api/index.ts')).href;
const FAILING = 'test/helpers/failing-tests.js';

/**
 * Runs through the same cross-process browser semaphore the shell helper uses. API runs launch
 * Chrome in-process rather than via `node cli.ts`, so without this they would sidestep the cap
 * that keeps concurrent Chrome instances below `availableParallelism()`.
 */
async function runApi(options: Parameters<typeof run>[0] = {}) {
  const permit = await acquireBrowser();
  try {
    return await run({ output: `tmp/api-${randomUUID()}`, ...options });
  } finally {
    permit.release();
  }
}

/**
 * Runs a driver script in a child process and returns everything it wrote. What the API writes
 * to its host's streams is only observable from outside: patching `process.stdout` in-process
 * would also swallow the test runner's own reporter output.
 */
async function outputOf(source: string) {
  const scriptPath = `tmp/api-driver-${randomUUID()}.mjs`;
  await fs.writeFile(scriptPath, `import { run } from '${API_ENTRY}';\n${source}`);
  const permit = await acquireBrowser();
  try {
    return await spawnCapture(`node ${scriptPath}`, {
      env: { ...process.env, QUNITX_NO_DAEMON: '1' },
    });
  } finally {
    permit.release();
    await fs.rm(scriptPath, { force: true });
  }
}

module('JS API: run()', { concurrency: true }, () => {
  test('resolves with counts, tests and an ok flag for a passing suite', async (assert) => {
    const result = await runApi({ files: [PASSING] });

    assert.true(result.ok);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.counts, {
      total: 3,
      passed: 3,
      failed: 0,
      skipped: 0,
      todo: 0,
    });
    assert.equal(result.tests.length, 3);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.failedFiles, []);
    assert.true(result.duration > 0);
  });

  test('reports failures with resolved stacks and source attribution', async (assert) => {
    const result = await runApi({ files: [FAILING] });

    assert.false(result.ok);
    assert.equal(result.exitCode, 1);
    assert.equal(result.counts.failed, 3);
    assert.equal(result.failures.length, 3);

    const failure = result.failures[0];
    assert.true(failure.fullName.length > 0);
    // Attribution and stacks must point at the user's source, never at the generated bundle —
    // that is the whole reason the API resolves them through the source map.
    assert.true(failure.file!.endsWith('failing-tests.js'));
    assert.equal(result.failedFiles.length, 1);

    const assertion = failure.assertions.find((entry) => !entry.passed)!;
    assert.true(assertion.stack!.includes('failing-tests.js'));
    assert.false(assertion.stack!.includes('tmp/'));
  });

  test('the handle streams runStart, testEnd and runEnd while the run is in flight', async (assert) => {
    const permit = await acquireBrowser();
    const events: string[] = [];
    try {
      const handle = run({ files: [PASSING], output: `tmp/api-${randomUUID()}` });
      handle
        .on('runStart', () => events.push('runStart'))
        .on('testEnd', (testResult) => events.push(`testEnd:${testResult.status}`))
        .on('runEnd', () => events.push('runEnd'));

      const result = await handle;

      assert.equal(events[0], 'runStart');
      assert.equal(events.at(-1), 'runEnd');
      assert.equal(events.filter((name) => name === 'testEnd:passed').length, 3);
      // The handle resolves to the same result the runEnd listener received.
      assert.equal(result.counts.total, 3);
    } finally {
      permit.release();
    }
  });

  test('writes nothing to stdout or stderr by default', async (assert) => {
    // A library that prints uninvited is unusable inside another tool's output, so 'none' is
    // the default reporter. Asserted from outside the process, which is the only place the
    // claim is actually observable.
    const silent = await outputOf(`
      const result = await run({ files: ['${PASSING}'], output: 'tmp/api-silent-${randomUUID()}' });
      if (!result.ok) throw new Error('expected a passing run');
    `);

    assert.equal(silent.stdout, '');
    assert.equal(silent.stderr, '');
    assert.equal(silent.code, 0);
  });

  test('an explicit reporter opts back into the CLI output', async (assert) => {
    const tap = await outputOf(`
      await run({ files: ['${PASSING}'], output: 'tmp/api-tap-${randomUUID()}', reporter: 'tap' });
    `);

    assert.includes(tap.stdout, 'TAP version 13');
    assert.includes(tap.stdout, 'ok 1');
  });

  test('a failing run does not set the host process exit code', async (assert) => {
    // The CLI exits 1 on failure; the API must report through the result instead and leave
    // the host to decide. Only observable as the child's own exit status.
    const failing = await outputOf(`
      const result = await run({ files: ['${FAILING}'], output: 'tmp/api-exit-${randomUUID()}' });
      if (result.ok) throw new Error('expected a failing run');
      if (result.exitCode !== 1) throw new Error('expected exitCode 1 on the result');
    `);

    assert.equal(failing.code, 0);
  });

  test('leaves the host process untouched — no exit, no exitCode, no signal handlers', async (assert) => {
    const exitCodeBefore = process.exitCode;
    const sigtermBefore = process.listenerCount('SIGTERM');

    const result = await runApi({ files: [FAILING] });

    // A failing run must be reported through the result, never by mutating the host's fate.
    assert.false(result.ok);
    assert.equal(process.exitCode, exitCodeBefore);
    assert.equal(process.listenerCount('SIGTERM'), sigtermBefore);
  });

  test('a filter narrows the run to matching tests', async (assert) => {
    const result = await runApi({ files: [PASSING], filter: 'deepEqual' });

    assert.equal(result.counts.total, 1);
    assert.includes(result.tests[0].fullName, 'deepEqual');
  });

  test('a file#line target runs only the test declared at that line', async (assert) => {
    const source = (await fs.readFile(PASSING, 'utf8')).split('\n');
    const line = source.findIndex((entry) => entry.includes("test('deepEqual true works'")) + 1;

    // Line targets are parsed by the CLI's input pipeline; the API routes `files` through it
    // rather than reimplementing them, so this is the check that the wiring holds.
    const result = await runApi({ files: [`${PASSING}#${line}`] });

    assert.equal(result.counts.total, 1);
    assert.includes(result.tests[0].fullName, 'deepEqual');
  });

  test('rejects instead of exiting when a named input does not exist', async (assert) => {
    // The CLI exits 1 here. Killing the host process is never acceptable for a library, so the
    // API surfaces the same condition as a rejected promise the caller can catch.
    await assert.rejects(runApi({ files: ['test/helpers/does-not-exist.js'] }));
  });

  test('a glob that matches nothing is an empty run, not an error', async (assert) => {
    const result = await runApi({ files: ['test/helpers/no-such-*.js'] });

    assert.true(result.ok);
    assert.equal(result.counts.total, 0);
    assert.deepEqual(result.tests, []);
  });
});

module('JS API: search()', { concurrency: true }, () => {
  test('lists declarations with their module path and line, without running them', async (assert) => {
    const found = await search({ files: [PASSING] });

    assert.equal(found.length, 3);
    const deepEqual = found.find((entry) => entry.name === 'deepEqual true works')!;
    assert.true(deepEqual.file.endsWith('passing-tests.js'));
    assert.true(deepEqual.line > 0);
    assert.equal(deepEqual.fullName, `${deepEqual.module.join(' > ')} > ${deepEqual.name}`);
  });

  test('applies the filter', async (assert) => {
    const found = await search({ files: [PASSING], filter: 'deepEqual' });

    assert.equal(found.length, 1);
    assert.equal(found[0].name, 'deepEqual true works');
  });
});
