import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';
import shell, { shellFails } from '../helpers/shell.ts';

module('--timeout flag tests for browser mode', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('--timeout=5000 with passing tests completes successfully', async (assert, testMetadata) => {
    const result = await shell('node cli.ts test/fixtures/passing-tests.js --timeout=5000', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.passingTestCaseFor(result, { testNo: 1, moduleName: '{{moduleName}}' });
    assert.tapResult(result, { testCount: 3 });
  });

  test('--timeout kills a test that hangs indefinitely and exits with code 1', async (assert, testMetadata) => {
    const cmd = await shellFails('node cli.ts test/helpers/slow-tests.ts --timeout=500', {
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

  // assert.timeout(ms) tests — per-test deadline set inside the test body (QUnit native).
  // Unlike --timeout (which kills the whole run when a test hangs), assert.timeout()
  // fails only the individual test and lets the suite finish normally.

  test('assert.timeout() passes when test finishes before its deadline', async (assert, testMetadata) => {
    const result = await shell('node cli.ts test/fixtures/assert-timeout-tests.ts', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.outputContains(result, {
      contains: [
        'TAP version 13',
        /ok \d+ .* assert\.timeout passes when test completes before deadline/,
        /ok \d+ .* assert\.timeout\(0\) passes for synchronous tests/,
      ],
    });
    assert.tapResult(result, { testCount: 2 });
  });

  test('assert.timeout() fails the individual test when its deadline is exceeded', async (assert, testMetadata) => {
    const cmd = await shellFails('node cli.ts test/fixtures/assert-timeout-slow-tests.ts', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.exitCode(cmd, 1, 'suite exits with code 1 when a test times out via assert.timeout()');
    assert.includes(cmd, 'TAP version 13', 'TAP header is printed');
    assert.outputContains(cmd, {
      contains: [
        // QUnit's per-test timeout message
        /Test took longer than \d+ms; test timed out\./,
        // The test itself is marked not-ok in TAP
        /not ok \d+ .* assert\.timeout fails when test exceeds deadline/,
      ],
      // assert.timeout() must NOT trigger the CLI-level watchdog message
      notContains: ['BROWSER: TEST TIMED OUT'],
    });
    assert.tapResult(cmd, { testCount: 1, failCount: 1 });
  });

  test('assert.timeout(0) enforces synchronous completion — fails async test', async (assert, testMetadata) => {
    // assert.timeout(0) means the test must not yield control at all.
    // An async test that awaits anything will fail with the sync-enforcement message.
    const cmd = await shellFails('node cli.ts test/fixtures/assert-timeout-sync-tests.ts', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.exitCode(cmd, 1, 'async test with timeout(0) exits with code 1');
    assert.outputContains(cmd, {
      contains: [
        /Test did not finish synchronously even though assert\.timeout\( 0 \) was used\./,
        /not ok \d+ .* assert\.timeout\(0\) fails async test/,
      ],
    });
  });
});
