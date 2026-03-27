import { module, test } from 'qunitx';
import { assertPassingTestCasesFor, assertTAPResult } from '../helpers/custom-asserts.ts';
import shell from '../helpers/shell.ts';

module('--before script tests for browser mode', (_hooks, moduleMetadata) => {
  test('--before works when it doesnt need to be awaited', async (assert, testMetadata) => {
    const result = await shell(
      'node cli.ts test/helpers/passing-tests.ts --before=test/helpers/before-script-basic.ts',
      { ...moduleMetadata, ...testMetadata },
    );

    assert.includes(result, 'This is running from before script!!');
    assertPassingTestCasesFor(assert, result, { moduleName: '{{moduleName}}' });
    assertTAPResult(assert, result, { testCount: 3 });
  });

  test('--before works it needs to be awaited', async (assert, testMetadata) => {
    const result = await shell(
      'node cli.ts test/helpers/passing-tests.ts test/helpers/before-script-web-server-tests.ts --before=test/helpers/before-script-async.ts',
      { ...moduleMetadata, ...testMetadata },
    );

    assert.includes(result, 'This is running from before script!!');
    assert.includes(result, 'Starting before script with:');
    assertPassingTestCasesFor(assert, result, { moduleName: '{{moduleName}}' });
    assert.includes(result, '{{moduleName}} Before script web server tests | assert true works');
    assertTAPResult(assert, result, { testCount: 4 });
  });
});
