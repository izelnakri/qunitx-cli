import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';
import { execute as shell, shellFails } from '../helpers/shell.ts';

module('Flags | --before', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('runs a synchronous script before the suite starts', async (assert, testMetadata) => {
    const result = await shell(
      'node cli.ts test/fixtures/passing-tests.ts --before=test/fixtures/before-script-basic.ts',
      { ...moduleMetadata, ...testMetadata },
    );

    assert.includes(result, 'This is running from before script!!');
    assert.passingTestCaseFor(result, { moduleName: '{{moduleName}}' });
    assert.tapResult(result, { testCount: 3 });
  });

  test('exits 1 and reports the error when the script throws', async (assert, testMetadata) => {
    const result = await shellFails(
      'node cli.ts test/fixtures/passing-tests.ts --before=test/fixtures/hook-script-throws.ts',
      { ...moduleMetadata, ...testMetadata },
    );

    assert.exitCode(result, 1);
    assert.includes(result.stdout, '# QUnitX before script failed:');
  });

  test('awaits an async script before the suite starts', async (assert, testMetadata) => {
    const result = await shell(
      'node cli.ts test/fixtures/passing-tests.ts test/fixtures/before-script-web-server-tests.ts --before=test/fixtures/before-script-async.ts',
      { ...moduleMetadata, ...testMetadata },
    );

    assert.includes(result, 'This is running from before script!!');
    assert.includes(result, 'Starting before script with:');
    assert.passingTestCaseFor(result, { moduleName: '{{moduleName}}' });
    assert.includes(result, '{{moduleName}} Before script web server tests | assert true works');
    assert.tapResult(result, { testCount: 4 });
  });
});
