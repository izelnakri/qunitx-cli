import { module, test } from 'qunitx';
import { writeTestFolder } from '../helpers/fs-writers.ts';
import '../helpers/custom-asserts.ts';
import shell, { shellFails } from '../helpers/shell.ts';

module('File and Folder Combination Tests', (_hooks, moduleMetadata) => {
  test('runs a file and a folder together when all tests pass', async (assert, testMetadata) => {
    const folderName = await writeTestFolder({ addFailingTests: false });

    const result = await shell(`node cli.ts tmp/${folderName} tmp/test/passing-tests.js`, {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.passingTestCasesFor(result, [
      { moduleName: `${folderName} | first-module-pass` },
      { moduleName: `${folderName} | second-module-pass` },
      { moduleName: '{{moduleName}}' },
    ]);
    // folder: 2 files × 3 tests = 6; extra file: 3 tests → 9 total
    assert.tapResult(result, { testCount: 9 });
  });

  test('runs a file and a folder together when the folder has failing tests', async (assert, testMetadata) => {
    const folderName = await writeTestFolder({ addFailingTests: true });

    const cmd = await shellFails(`node cli.ts tmp/${folderName} tmp/test/passing-tests.js`, {
      ...moduleMetadata,
      ...testMetadata,
    });
    assert.exitCode(cmd, 1, 'expected shell to exit non-zero due to failing tests');
    assert.passingTestCasesFor(cmd, [
      { moduleName: `${folderName} | first-module-pass` },
      { moduleName: `${folderName} | second-module-pass` },
    ]);
    assert.failingTestCasesFor(cmd, [
      { moduleName: `${folderName} | first-module-fail` },
      { moduleName: `${folderName} | second-module-fail` },
      { moduleName: `${folderName} | third-module-fail` },
    ]);
    assert.outputContains(
      cmd,
      {
        contains: [/actual:\n\s+firstName: Izel/, /expected:\n\s+firstName: Isaac/],
      },
      'deepEqual failure shows structured YAML object diff',
    );
    // folder (addFailingTests:true): 2 passing files×3 + 3 failing files×4 = 18 tests (9 pass, 9 fail)
    // extra passing-tests.js: 3 tests → grand total 21 tests (12 pass, 9 fail)
    assert.tapResult(cmd, { testCount: 21, failCount: 9 });
  });
});
