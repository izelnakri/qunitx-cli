import { module, test } from 'qunitx';
import { assertPassingTestCase, assertTAPResult } from '../helpers/custom-asserts.js';
import shell, { shellFails } from '../helpers/shell.js';

module('--timeout flag tests for browser mode', (_hooks, moduleMetadata) => {
  test('--timeout=5000 with passing tests completes successfully', async (assert, testMetadata) => {
    const result = await shell('node cli.js tmp/test/passing-tests.js --timeout=5000', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assertPassingTestCase(assert, result, { testNo: 1, moduleName: '{{moduleName}}' });
    assertTAPResult(assert, result, { testCount: 3 });
  });

  test('--timeout kills a test that hangs indefinitely and exits with code 1', async (assert, testMetadata) => {
    // The window.testTimeout counter increments by 1000 every second and resets after each test.
    // With --timeout=500, it triggers after ~1 second, before slow-tests.js can finish.
    const cmd = await shellFails('node cli.js test/helpers/slow-tests.js --timeout=500', {
      ...moduleMetadata,
      ...testMetadata,
    });
    assert.exitCode(cmd, 1, 'expected a non-zero exit code for a hanging test');
    assert.includes(cmd, 'TAP version 13', 'TAP header is still printed');
    assert.includes(
      cmd,
      'BROWSER: TEST TIMED OUT',
      'timeout is reported with the name of the hanging test',
    );
  });
});
