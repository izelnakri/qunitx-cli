import { module, test } from 'qunitx';
import {
  assertPassingTestCase,
  assertFailingTestCase,
  assertTAPResult,
} from '../helpers/custom-asserts.js';
import shell from '../helpers/shell.js';

module('--after script tests for browser mode', (_hooks, moduleMetadata) => {
  test('--after works when it doesnt need to be awaited', async (assert, testMetadata) => {
    const result = await shell(
      'node cli.js test/helpers/passing-tests.js --after=test/helpers/after-script-basic.js',
      { ...moduleMetadata, ...testMetadata },
    );

    assert.includes(result, 'This is running from after script!!');
    assertPassingTestCase(assert, result, { moduleName: '{{moduleName}}' });
    assertTAPResult(assert, result, { testCount: 3 });
  });

  test('--after works when it needs to be awaited', async (assert, testMetadata) => {
    const result = await shell(
      'node cli.js test/helpers/passing-tests.js --after=test/helpers/after-script-async.js',
      { ...moduleMetadata, ...testMetadata },
    );

    assert.includes(result, 'This is running from after script!!');
    assert.includes(result, 'After script result is written:');
    assert.includes(
      result,
      JSON.stringify(
        { testCount: 3, failCount: 0, skipCount: 0, passCount: 3, errorCount: 0 },
        null,
        2,
      ),
    );
    assertPassingTestCase(assert, result, { moduleName: '{{moduleName}}' });
    assertTAPResult(assert, result, { testCount: 3 });
  });
});
