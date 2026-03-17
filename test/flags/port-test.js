import { module, test } from 'qunitx';
import { assertPassingTestCase, assertTAPResult } from '../helpers/assert-stdout.js';
import shell from '../helpers/shell.js';

// Note: bindServerToPort always calls server.listen(0) so the OS assigns the actual port,
// ignoring the value of --port. The flag is still parsed and stored on config; these tests
// verify that providing it does not break the run in any way.
module('--port flag tests for browser mode', (_hooks, moduleMetadata) => {
  test('--port flag is accepted and tests complete successfully', async (assert, testMetadata) => {
    const { stdout } = await shell('node cli.js tmp/test/passing-tests.js --port=5678', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assertPassingTestCase(assert, stdout, { moduleName: '{{moduleName}}' });
    assertTAPResult(assert, stdout, { testCount: 3 });
  });

  test('--port flag combined with --debug still shows the server URL', async (assert, testMetadata) => {
    const { stdout } = await shell('node cli.js tmp/test/passing-tests.js --port=5678 --debug', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.ok(
      new RegExp(/# QUnitX running: http:\/\/localhost:\d+/).test(stdout),
      'debug output includes the server URL with an assigned port',
    );
    assertPassingTestCase(assert, stdout, { debug: true, moduleName: '{{moduleName}}' });
    assertTAPResult(assert, stdout, { testCount: 3 });
  });
});
