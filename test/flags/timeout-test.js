import { module, test } from 'qunitx';
import { assertPassingTestCase, assertTAPResult } from '../helpers/assert-stdout.js';
import shell from '../helpers/shell.js';

module('--timeout flag tests for browser mode', (_hooks, moduleMetadata) => {
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

  test('--timeout kills a test that hangs indefinitely and exits with code 1', async (assert, testMetadata) => {
    // The window.testTimeout counter increments by 1000 every second and resets after each test.
    // With --timeout=500, it triggers after ~1 second, before slow-tests.js can finish.
    try {
      await shell('node cli.js test/helpers/slow-tests.js --timeout=500', {
        ...moduleMetadata,
        ...testMetadata,
      });
      assert.ok(false, 'expected a non-zero exit code for a hanging test');
    } catch (cmd) {
      assert.ok(cmd.stdout.includes('TAP version 13'), 'TAP header is still printed');
      assert.ok(
        cmd.stdout.includes('BROWSER: TEST TIMED OUT'),
        'timeout is reported with the name of the hanging test',
      );
    }
  });
});
