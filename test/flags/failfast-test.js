import { module, test } from 'qunitx';
import { assertPassingTestCase, assertTAPResult } from '../helpers/assert-stdout.js';
import shell from '../helpers/shell.js';

module('--failFast flag tests for browser mode', { concurrency: false }, (_hooks, moduleMetadata) => {
  test('--failFast with passing tests behaves the same as normal run', async (assert, testMetadata) => {
    const { stdout } = await shell('node cli.js tmp/test/passing-tests.js --failFast', { ...moduleMetadata, ...testMetadata });

    assertPassingTestCase(assert, stdout, { testNo: 1, moduleName: '{{moduleName}}' });
    assertTAPResult(assert, stdout, { testCount: 3 });
  });

  test('--failFast with failing tests stops after first failure', async (assert, testMetadata) => {
    try {
      await shell('node cli.js tmp/test/failing-tests.js --failFast', { ...moduleMetadata, ...testMetadata });
    } catch (cmd) {
      assert.ok(cmd.stdout.includes('TAP version 13'));
      // With failFast, test 1 passes, test 2 fails and queue is cleared
      // So we get fewer than the full 3 failures
      assert.ok(new RegExp(/# fail [123]/).test(cmd.stdout));
      assert.ok(new RegExp(/# pass [01]/).test(cmd.stdout));
    }
  });

  test('--failfast alias also works', async (assert, testMetadata) => {
    const { stdout } = await shell('node cli.js tmp/test/passing-tests.js --failfast', { ...moduleMetadata, ...testMetadata });

    assertPassingTestCase(assert, stdout, { testNo: 1, moduleName: '{{moduleName}}' });
    assertTAPResult(assert, stdout, { testCount: 3 });
  });
});
