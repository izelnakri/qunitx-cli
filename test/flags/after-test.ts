import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';
import shell, { shellFails } from '../helpers/shell.ts';

module('--after script tests for browser mode', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('--after works when it doesnt need to be awaited', async (assert, testMetadata) => {
    const result = await shell(
      'node cli.ts test/helpers/passing-tests.ts --after=test/helpers/after-script-basic.ts',
      { ...moduleMetadata, ...testMetadata },
    );

    assert.includes(result, 'This is running from after script!!');
    assert.passingTestCaseFor(result, { moduleName: '{{moduleName}}' });
    assert.tapResult(result, { testCount: 3 });
  });

  test('--after exits with code 1 and reports error when script throws', async (assert, testMetadata) => {
    const result = await shellFails(
      'node cli.ts test/helpers/passing-tests.ts --after=test/helpers/hook-script-throws.ts',
      { ...moduleMetadata, ...testMetadata },
    );

    assert.exitCode(result, 1);
    assert.includes(result.stdout, '# QUnitX after script failed:');
  });

  test('--after works when it needs to be awaited', async (assert, testMetadata) => {
    const result = await shell(
      'node cli.ts test/helpers/passing-tests.ts --after=test/helpers/after-script-async.ts',
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
    assert.passingTestCaseFor(result, { moduleName: '{{moduleName}}' });
    assert.tapResult(result, { testCount: 3 });
  });
});
