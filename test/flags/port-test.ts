import { module, test } from 'qunitx';
import { assertPassingTestCasesFor, assertTAPResult } from '../helpers/custom-asserts.ts';
import shell from '../helpers/shell.ts';

// Note: bindServerToPort always calls server.listen(0) so the OS assigns the actual port,
// ignoring the value of --port. The flag is still parsed and stored on config; these tests
// verify that providing it does not break the run in any way.
module('--port flag tests for browser mode', (_hooks, moduleMetadata) => {
  test('--port flag is accepted and tests complete successfully', async (assert, testMetadata) => {
    const result = await shell('node cli.ts tmp/test/passing-tests.js --port=5678', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assertPassingTestCasesFor(assert, result, { moduleName: '{{moduleName}}' });
    assertTAPResult(assert, result, { testCount: 3 });
  });

  test('--port flag combined with --debug still shows the server URL', async (assert, testMetadata) => {
    const result = await shell('node cli.ts tmp/test/passing-tests.js --port=5678 --debug', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.hasDebugURL(result, 'debug output includes the server URL with an assigned port');
    assertPassingTestCasesFor(assert, result, { debug: true, moduleName: '{{moduleName}}' });
    assertTAPResult(assert, result, { testCount: 3 });
  });
});
