import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';
import shell, { shellFails } from '../helpers/shell.ts';

module('File Input Tests', { concurrency: true }, (_hooks, moduleMetadata) => {
  // Each paired test runs two `node cli.ts` invocations concurrently via Promise.all.
  // Both semaphore slots are acquired simultaneously, so wall time = max(a, b) not a + b.

  test('testing passing js file: without and with --debug', async (assert, testMetadata) => {
    const [result, debugResult] = await Promise.all([
      shell('node cli.ts test/fixtures/passing-tests.js', { ...moduleMetadata, ...testMetadata }),
      shell('node cli.ts test/fixtures/passing-tests.js --debug', {
        ...moduleMetadata,
        ...testMetadata,
      }),
    ]);

    assert.passingTestCaseFor(result, { testNo: 1, moduleName: '{{moduleName}}' });
    assert.tapResult(result, { testCount: 3 });

    assert.hasDebugURL(debugResult);
    assert.includes(debugResult, 'TAP version 13');
    assert.passingTestCaseFor(debugResult, {
      debug: true,
      testNo: 1,
      moduleName: '{{moduleName}}',
    });
    assert.tapResult(debugResult, { testCount: 3 });
  });

  test('testing failing js file: without and with --debug', async (assert, testMetadata) => {
    const [cmd, debugCmd] = await Promise.all([
      shellFails('node cli.ts test/fixtures/failing-tests.js', {
        ...moduleMetadata,
        ...testMetadata,
      }),
      shellFails('node cli.ts test/fixtures/failing-tests.js --debug', {
        ...moduleMetadata,
        ...testMetadata,
      }),
    ]);

    assert.exitCode(cmd, 1, 'expected shell to exit non-zero due to failing tests');
    assert.includes(cmd, 'TAP version 13');
    assert.failingTestCaseFor(cmd, { testNo: 1, moduleName: '{{moduleName}}' });
    assert.outputContains(
      cmd,
      { contains: [/actual:\n\s+firstName: Izel/, /expected:\n\s+firstName: Isaac/] },
      'deepEqual failure shows structured YAML object diff',
    );
    assert.tapResult(cmd, { testCount: 4, failCount: 3 });

    assert.exitCode(
      debugCmd,
      1,
      'debug mode: expected shell to exit non-zero due to failing tests',
    );
    assert.includes(debugCmd, 'TAP version 13');
    assert.failingTestCaseFor(debugCmd, { debug: true, testNo: 1, moduleName: '{{moduleName}}' });
    assert.tapResult(debugCmd, { testCount: 4, failCount: 3 });
  });

  test('testing passing ts file: without and with --debug', async (assert, testMetadata) => {
    const [result, debugResult] = await Promise.all([
      shell('node cli.ts test/fixtures/passing-tests.ts', { ...moduleMetadata, ...testMetadata }),
      shell('node cli.ts test/fixtures/passing-tests.ts --debug', {
        ...moduleMetadata,
        ...testMetadata,
      }),
    ]);

    assert.includes(result, 'TAP version 13');
    assert.passingTestCaseFor(result, { testNo: 1, moduleName: '{{moduleName}}' });
    assert.tapResult(result, { testCount: 3 });

    assert.hasDebugURL(debugResult);
    assert.includes(debugResult, 'TAP version 13');
    assert.passingTestCaseFor(debugResult, {
      debug: true,
      testNo: 1,
      moduleName: '{{moduleName}}',
    });
    assert.tapResult(debugResult, { testCount: 3 });
  });

  test('testing failing ts file: without and with --debug', async (assert, testMetadata) => {
    const [cmd, debugCmd] = await Promise.all([
      shellFails('node cli.ts test/fixtures/failing-tests.ts', {
        ...moduleMetadata,
        ...testMetadata,
      }),
      shellFails('node cli.ts test/fixtures/failing-tests.ts --debug', {
        ...moduleMetadata,
        ...testMetadata,
      }),
    ]);

    assert.exitCode(cmd, 1, 'expected shell to exit non-zero due to failing tests');
    assert.includes(cmd, 'TAP version 13');
    assert.failingTestCaseFor(cmd, { testNo: 1, moduleName: '{{moduleName}}' });
    assert.outputContains(
      cmd,
      { contains: [/actual:\n\s+firstName: Izel/, /expected:\n\s+firstName: Isaac/] },
      'deepEqual failure shows structured YAML object diff',
    );
    assert.tapResult(cmd, { testCount: 4, failCount: 3 });

    assert.exitCode(
      debugCmd,
      1,
      'debug mode: expected shell to exit non-zero due to failing tests',
    );
    assert.includes(debugCmd, 'TAP version 13');
    assert.failingTestCaseFor(debugCmd, { debug: true, testNo: 1, moduleName: '{{moduleName}}' });
    assert.tapResult(debugCmd, { testCount: 4, failCount: 3 });
  });

  test('test.skip produces "ok ... # skip" TAP lines and test.todo produces "not ok ... # skip" without counting as failures', async (assert, testMetadata) => {
    const result = await shell('node cli.ts test/helpers/skip-todo-tests.ts', {
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
      'todo test is expected to fail # skip',
      'todo test appears as "not ok ... # skip"',
    );
    assert.tapResult(result, { testCount: 1, skipCount: 1 });
  });
});
