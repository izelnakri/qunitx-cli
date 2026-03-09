import { module, test } from 'qunitx';
import { assertPassingTestCase, assertTAPResult } from '../helpers/assert-stdout.js';
import shell from '../helpers/shell.js';

module(
  '--timeout flag tests for browser mode',
  (_hooks, moduleMetadata) => {
    test('--timeout=5000 with passing tests completes successfully', async (assert, testMetadata) => {
      const { stdout } = await shell('node cli.js tmp/test/passing-tests.js --timeout=5000', {
        ...moduleMetadata,
        ...testMetadata,
      });

      assertPassingTestCase(assert, stdout, { testNo: 1, moduleName: '{{moduleName}}' });
      assertTAPResult(assert, stdout, { testCount: 3 });
    });

    test('--timeout=1000 still passes for fast tests', async (assert, testMetadata) => {
      const { stdout } = await shell('node cli.js tmp/test/passing-tests.js --timeout=1000', {
        ...moduleMetadata,
        ...testMetadata,
      });

      assertPassingTestCase(assert, stdout, { testNo: 1, moduleName: '{{moduleName}}' });
      assertTAPResult(assert, stdout, { testCount: 3 });
    });
  },
);
