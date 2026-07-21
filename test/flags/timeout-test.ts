import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';
import { execute as shell, shellFails } from '../helpers/shell.ts';

module('Flags | --timeout', { concurrency: true }, (_hooks, moduleMetadata) => {
  // The only observable effect of --timeout is a deadline that actually fires: the value
  // reaching QUnit.config.testTimeout as a number is owned by
  // test/args/parse-test.ts 'Args | parse | --timeout'.
  test('marks a hanging test as failed and exits with code 1', async (assert, testMetadata) => {
    const cmd = await shellFails('node cli.ts test/fixtures/slow-tests.ts --timeout=500', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.exitCode(cmd, 1, 'expected a non-zero exit code for a hanging test');
    assert.outputContains(cmd, {
      contains: [
        'TAP version 13',
        /not ok \d+ .*this test hangs forever/,
        /Test took longer than \d+ms; test timed out\./,
      ],
      notContains: ['BROWSER: TEST TIMED OUT'],
    });
    assert.tapResult(cmd, { testCount: 1, failCount: 1 });
  });
});

// assert.timeout(ms) — per-test deadline set inside the test body (QUnit native). --timeout sets
// QUnit.config.testTimeout globally for the run; assert.timeout() overrides it per-test. Both
// mark only the timed-out test as failed and let the suite continue.
module('Flags | --timeout | assert.timeout()', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('passes tests that finish before their deadline', async (assert, testMetadata) => {
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

  test('fails the individual test whose deadline is exceeded', async (assert, testMetadata) => {
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
      notContains: ['BROWSER: TEST TIMED OUT'],
    });
    assert.tapResult(cmd, { testCount: 1, failCount: 1 });
  });

  test('fails an async test given assert.timeout(0)', async (assert, testMetadata) => {
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
