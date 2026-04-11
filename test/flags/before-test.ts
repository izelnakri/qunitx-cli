import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';
import shell, { shellFails } from '../helpers/shell.ts';

module('--before script tests for browser mode', (_hooks, moduleMetadata) => {
  test('--before works when it doesnt need to be awaited', async (assert, testMetadata) => {
    const result = await shell(
      'node cli.ts test/helpers/passing-tests.ts --before=test/helpers/before-script-basic.ts',
      { ...moduleMetadata, ...testMetadata },
    );

    assert.includes(result, 'This is running from before script!!');
    assert.passingTestCaseFor(result, { moduleName: '{{moduleName}}' });
    assert.tapResult(result, { testCount: 3 });
  });

  test('--before exits with code 1 and reports error when script throws', async (assert, testMetadata) => {
    const result = await shellFails(
      'node cli.ts test/helpers/passing-tests.ts --before=test/helpers/hook-script-throws.ts',
      { ...moduleMetadata, ...testMetadata },
    );

    assert.exitCode(result, 1);
    assert.includes(result.stdout, '# QUnitX before script failed:');
  });

  test('--before works it needs to be awaited', async (assert, testMetadata) => {
    const result = await shell(
      'node cli.ts test/helpers/passing-tests.ts test/helpers/before-script-web-server-tests.ts --before=test/helpers/before-script-async.ts',
      { ...moduleMetadata, ...testMetadata },
    );

    assert.includes(result, 'This is running from before script!!');
    assert.includes(result, 'Starting before script with:');
    assert.passingTestCaseFor(result, { moduleName: '{{moduleName}}' });
    assert.includes(result, '{{moduleName}} Before script web server tests | assert true works');
    assert.tapResult(result, { testCount: 4 });
  });
});
