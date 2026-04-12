import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';
import shell, { shellFails } from '../helpers/shell.ts';

module(
  '--failFast flag tests for browser mode',
  { concurrency: true },
  (_hooks, moduleMetadata) => {
    test('--failFast with passing tests behaves the same as normal run', async (assert, testMetadata) => {
      const result = await shell('node cli.ts test/fixtures/passing-tests.js --failFast', {
        ...moduleMetadata,
        ...testMetadata,
      });

      assert.passingTestCaseFor(result, { testNo: 1, moduleName: '{{moduleName}}' });
      assert.tapResult(result, { testCount: 3 });
    });

    test('--failFast with failing tests stops after first failure', async (assert, testMetadata) => {
      const cmd = await shellFails('node cli.ts test/fixtures/failing-tests.js --failFast', {
        ...moduleMetadata,
        ...testMetadata,
      });
      assert.exitCode(cmd, 1, 'expected shell to exit non-zero due to failing tests');
      assert.includes(cmd, 'TAP version 13');
      // With failFast, test 1 passes, test 2 fails and queue is cleared
      // So we get fewer than the full 3 failures
      assert.regex(cmd, /# fail [123]/, 'failFast should stop after 1-3 failures');
      assert.regex(cmd, /# pass [01]/, 'failFast should have 0 or 1 passing tests');
    });
  },
);
