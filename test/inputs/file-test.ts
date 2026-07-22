import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';
import { execute as shell, shellFails } from '../helpers/shell.ts';

module('Inputs | single file', { concurrency: true }, (_hooks, moduleMetadata) => {
  // Two axes are being crossed here, and they are independent: the source extension
  // (.js vs .ts, which decides whether esbuild has to strip types) and --debug (which adds
  // the server URL and lets console output through). Crossing them fully would be four runs
  // per outcome to learn nothing new, so extension is exercised per outcome and --debug once
  // per outcome. Every test pairs its runs under Promise.all, so both semaphore slots are
  // held at once and wall time is max(a, b) rather than a + b.

  test('a passing .js and .ts file each report all three tests as TAP ok lines', async (assert, testMetadata) => {
    const metadata = { ...moduleMetadata, ...testMetadata };
    const [js, ts] = await Promise.all([
      shell('node cli.ts test/fixtures/passing-tests.js', metadata),
      shell('node cli.ts test/fixtures/passing-tests.ts', metadata),
    ]);

    for (const result of [js, ts]) {
      assert.includes(result, 'TAP version 13');
      assert.passingTestCaseFor(result, { testNo: 1, moduleName: '{{moduleName}}' });
      assert.tapResult(result, { testCount: 3 });
    }
  });

  test('a failing .js and .ts file each exit 1 and show a structured YAML diff', async (assert, testMetadata) => {
    const metadata = { ...moduleMetadata, ...testMetadata };
    const [js, ts] = await Promise.all([
      shellFails('node cli.ts test/fixtures/failing-tests.js', metadata),
      shellFails('node cli.ts test/fixtures/failing-tests.ts', metadata),
    ]);

    for (const cmd of [js, ts]) {
      assert.exitCode(cmd, 1, 'expected shell to exit non-zero due to failing tests');
      assert.includes(cmd, 'TAP version 13');
      assert.failingTestCaseFor(cmd, { testNo: 1, moduleName: '{{moduleName}}' });
      assert.outputContains(
        cmd,
        { contains: [/actual:\n\s+firstName: Izel/, /expected:\n\s+firstName: Isaac/] },
        'deepEqual failure shows structured YAML object diff',
      );
      assert.tapResult(cmd, { testCount: 4, failCount: 3 });
    }
  });

  test('--debug prints the server URL and lets the page console through, pass or fail', async (assert, testMetadata) => {
    const metadata = { ...moduleMetadata, ...testMetadata };
    const [passing, failing] = await Promise.all([
      shell('node cli.ts test/fixtures/passing-tests.ts --debug', metadata),
      shellFails('node cli.ts test/fixtures/failing-tests.ts --debug', metadata),
    ]);

    assert.hasDebugURL(passing);
    assert.includes(passing, 'TAP version 13');
    assert.passingTestCaseFor(passing, { debug: true, testNo: 1, moduleName: '{{moduleName}}' });
    assert.tapResult(passing, { testCount: 3 });

    assert.exitCode(failing, 1, 'debug mode: expected shell to exit non-zero due to failing tests');
    assert.includes(failing, 'TAP version 13');
    assert.failingTestCaseFor(failing, { debug: true, testNo: 1, moduleName: '{{moduleName}}' });
    assert.tapResult(failing, { testCount: 4, failCount: 3 });
  });

  test('test.skip reports "ok # skip", test.todo "not ok # TODO", neither as a failure', async (assert, testMetadata) => {
    const result = await shell('node cli.ts test/fixtures/skip-todo-tests.ts', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.includes(
      result,
      'skipped test is not executed # skip',
      'skipped test appears as "ok ... # skip"',
    );
    assert.includes(
      result,
      'todo test is expected to fail # TODO',
      'todo test appears as "not ok ... # TODO"',
    );
    assert.tapResult(result, { testCount: 1, skipCount: 1, todoCount: 1 });
  });
});
