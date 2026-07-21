import { module, test } from 'qunitx';
import { writeTestFolder, writeNestedTestFolder } from '../helpers/fs-writers.ts';
import '../helpers/custom-asserts.ts';
import { execute as shell, shellFails } from '../helpers/shell.ts';

module('Inputs | folder', { concurrency: true }, (_hooks, moduleMetadata) => {
  // What is specific to a folder input is discovery and aggregation: which files get found,
  // and how their counts add up into one TAP plan. --debug is orthogonal to all of that — it
  // is the same flag on the same runner whatever the input shape — so it is exercised once,
  // in Inputs | single file, rather than paired against every case here.

  test('discovers test files in nested subdirectories, at every depth', async (assert, testMetadata) => {
    const folderName = await writeNestedTestFolder();

    const result = await shell(`node cli.ts tmp/${folderName}`, {
      ...moduleMetadata,
      ...testMetadata,
    });

    // flat.ts (root), subdir/nested.ts, subdir/deeper/deep.ts — all 3 files × 3 tests = 9 total.
    assert.passingTestCasesFor(result, [
      { moduleName: `${folderName} | flat` },
      { moduleName: `${folderName} | subdir-nested` },
      { moduleName: `${folderName} | subdir-deeper-deep` },
    ]);
    assert.tapResult(result, { testCount: 9 });
  });

  test('runs every test file in a passing folder as one plan', async (assert, testMetadata) => {
    const folderName = await writeTestFolder({ addFailingTests: false });

    const result = await shell(`node cli.ts tmp/${folderName}`, {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.passingTestCasesFor(result, [
      { moduleName: `${folderName} | first-module-pass` },
      { moduleName: `${folderName} | second-module-pass` },
    ]);
    assert.tapResult(result, { testCount: 6 });
  });

  test('exits 1 and reports the passing and failing modules of one folder side by side', async (assert, testMetadata) => {
    const folderName = await writeTestFolder({ addFailingTests: true });

    const cmd = await shellFails(`node cli.ts tmp/${folderName}`, {
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
      { contains: [/actual:\n\s+firstName: Izel/, /expected:\n\s+firstName: Isaac/] },
      'deepEqual failure shows structured YAML object diff',
    );
    assert.tapResult(cmd, { testCount: 18, failCount: 9 });
  });

  test('aggregates several folders into one plan, counting failures across all of them', async (assert, testMetadata) => {
    // A mixed pair rather than two clean folders: this proves discovery of both inputs AND
    // that a failure in one does not suppress the other's results, which a two-clean-folder
    // case cannot show.
    const [firstFolderName, secondFolderName] = await Promise.all([
      writeTestFolder({ addFailingTests: true }),
      writeTestFolder({ addFailingTests: false }),
    ]);

    const cmd = await shellFails(`node cli.ts tmp/${firstFolderName} tmp/${secondFolderName}`, {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.exitCode(cmd, 1, 'expected shell to exit non-zero due to failing tests');
    assert.passingTestCasesFor(cmd, [
      { moduleName: `${firstFolderName} | first-module-pass` },
      { moduleName: `${firstFolderName} | second-module-pass` },
      { moduleName: `${secondFolderName} | first-module-pass` },
      { moduleName: `${secondFolderName} | second-module-pass` },
    ]);
    assert.failingTestCasesFor(cmd, [
      { moduleName: `${firstFolderName} | first-module-fail` },
      { moduleName: `${firstFolderName} | second-module-fail` },
      { moduleName: `${firstFolderName} | third-module-fail` },
    ]);
    // firstFolder: 2×3 + 3×4 = 18 tests (9 fail); secondFolder: 2×3 = 6 tests → 24 total, 9 fail
    assert.tapResult(cmd, { testCount: 24, failCount: 9 });
  });
});
