import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';
import { shellFails } from '../helpers/shell.ts';

module('Flags | --failFast', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('clears the queue after the first failure and exits 1', async (assert, testMetadata) => {
    const cmd = await shellFails('node cli.ts test/fixtures/failing-tests.js --failFast', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.exitCode(cmd, 1, 'expected shell to exit non-zero due to failing tests');
    assert.includes(cmd, 'TAP version 13');
    // With failFast, test 1 passes, test 2 fails and the queue is cleared, so fewer than the
    // full 3 failures are reported.
    assert.regex(cmd, /# fail [123]/, 'failFast should stop after 1-3 failures');
    assert.regex(cmd, /# pass [01]/, 'failFast should have 0 or 1 passing tests');
  });
});
