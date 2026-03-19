import { module, test } from 'qunitx';
import {
  assertPassingTestCase,
  assertFailingTestCase,
  assertTAPResult,
} from '../helpers/custom-asserts.js';
import shell, { shellFails } from '../helpers/shell.js';

module('File Input Tests', (_hooks, moduleMetadata) => {
  test('testing a single passing js file with works, console output supressed', async (assert, testMetadata) => {
    const result = await shell('node cli.js tmp/test/passing-tests.js', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assertPassingTestCase(assert, result, { testNo: 1, moduleName: '{{moduleName}}' });
    assertTAPResult(assert, result, { testCount: 3 });
  });

  test('testing a single passing js file with --debug works', async (assert, testMetadata) => {
    const result = await shell('node cli.js tmp/test/passing-tests.js --debug', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.hasDebugURL(result);
    assert.includes(result, 'TAP version 13');
    assertPassingTestCase(assert, result, { debug: true, testNo: 1, moduleName: '{{moduleName}}' });
    assertTAPResult(assert, result, { testCount: 3 });
  });

  test('testing a single failing js file works', async (assert, testMetadata) => {
    const cmd = await shellFails('node cli.js tmp/test/failing-tests.js', {
      ...moduleMetadata,
      ...testMetadata,
    });
    assert.ok(cmd, 'expected shell to exit non-zero due to failing tests');
    assert.includes(cmd, 'TAP version 13');
    assertFailingTestCase(assert, cmd, { testNo: 1, moduleName: '{{moduleName}}' });
    assertTAPResult(assert, cmd, { testCount: 4, failCount: 3 });
  });

  test('testing a single failing js file with --debug works', async (assert, testMetadata) => {
    const cmd = await shellFails('node cli.js tmp/test/failing-tests.js --debug', {
      ...moduleMetadata,
      ...testMetadata,
    });
    assert.ok(cmd, 'expected shell to exit non-zero due to failing tests');
    assert.includes(cmd, 'TAP version 13');
    assertFailingTestCase(assert, cmd, { debug: true, testNo: 1, moduleName: '{{moduleName}}' });
    assertTAPResult(assert, cmd, { testCount: 4, failCount: 3 });
  });

  test('testing a single passing ts file works, console output supressed', async (assert, testMetadata) => {
    const result = await shell('node cli.js tmp/test/passing-tests.ts', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.includes(result, 'TAP version 13');
    assertPassingTestCase(assert, result, { testNo: 1, moduleName: '{{moduleName}}' });
    assertTAPResult(assert, result, { testCount: 3 });
  });

  test('testing a single passing ts file with --debug works', async (assert, testMetadata) => {
    const result = await shell('node cli.js tmp/test/passing-tests.ts --debug', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.hasDebugURL(result);
    assert.includes(result, 'TAP version 13');
    assertPassingTestCase(assert, result, { debug: true, testNo: 1, moduleName: '{{moduleName}}' });
    assertTAPResult(assert, result, { testCount: 3 });
  });

  test('testing a single failing ts file works', async (assert, testMetadata) => {
    const cmd = await shellFails('node cli.js tmp/test/failing-tests.ts', {
      ...moduleMetadata,
      ...testMetadata,
    });
    assert.ok(cmd, 'expected shell to exit non-zero due to failing tests');
    assert.includes(cmd, 'TAP version 13');
    assertFailingTestCase(assert, cmd, { testNo: 1, moduleName: '{{moduleName}}' });
    assertTAPResult(assert, cmd, { testCount: 4, failCount: 3 });
  });

  test('testing a single failing ts file with --debug works', async (assert, testMetadata) => {
    const cmd = await shellFails('node cli.js tmp/test/failing-tests.ts --debug', {
      ...moduleMetadata,
      ...testMetadata,
    });
    assert.ok(cmd, 'expected shell to exit non-zero due to failing tests');
    assert.includes(cmd, 'TAP version 13');
    assertFailingTestCase(assert, cmd, { debug: true, testNo: 1, moduleName: '{{moduleName}}' });
    assertTAPResult(assert, cmd, { testCount: 4, failCount: 3 });
  });

  test('test.skip produces "ok ... # skip" TAP lines and test.todo produces "not ok ... # skip" without counting as failures', async (assert, testMetadata) => {
    const result = await shell('node cli.js test/helpers/skip-todo-tests.js', {
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
    assertTAPResult(assert, result, { testCount: 1, skipCount: 1 });
  });
});
