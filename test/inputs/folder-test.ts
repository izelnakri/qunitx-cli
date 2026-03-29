import { module, test } from 'qunitx';
import { writeTestFolder } from '../helpers/fs-writers.ts';
import '../helpers/custom-asserts.ts';
import shell, { shellFails } from '../helpers/shell.ts';

module('Folder Input Tests', (_hooks, moduleMetadata) => {
  test('works for a single folder input in browser mode with all passing tests', async (assert, testMetadata) => {
    let folderName = await writeTestFolder({ addFailingTests: false });

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

  test('works for a single folder input in browser mode with few failing tests', async (assert, testMetadata) => {
    let folderName = await writeTestFolder({ addFailingTests: true });

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
      {
        contains: [/actual:\n\s+firstName: Izel/, /expected:\n\s+firstName: Isaac/],
      },
      'deepEqual failure shows structured YAML object diff',
    );
    assert.tapResult(cmd, { testCount: 18, failCount: 9 });
  });

  test('works for a multiple folders input in browser mode with all passing tests', async (assert, testMetadata) => {
    let firstFolderName = await writeTestFolder({ addFailingTests: false });
    let secondFolderName = await writeTestFolder({ addFailingTests: false });

    const result = await shell(`node cli.ts tmp/${firstFolderName} tmp/${secondFolderName}`, {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.passingTestCasesFor(result, [
      { moduleName: `${firstFolderName} | first-module-pass` },
      { moduleName: `${firstFolderName} | second-module-pass` },
      { moduleName: `${secondFolderName} | first-module-pass` },
      { moduleName: `${secondFolderName} | second-module-pass` },
    ]);
    assert.tapResult(result, { testCount: 12 });
  });

  test('works for a multiple folders input in browser mode with few failing tests', async (assert, testMetadata) => {
    let firstFolderName = await writeTestFolder({ addFailingTests: true });
    let secondFolderName = await writeTestFolder({ addFailingTests: false });

    const cmd = await shellFails(`node cli.ts tmp/${firstFolderName} tmp/${secondFolderName}`, {
      ...moduleMetadata,
      ...testMetadata,
    });
    assert.exitCode(cmd, 1, 'expected shell to exit non-zero due to failing tests');
    assert.passingTestCasesFor(cmd, [
      { moduleName: `${firstFolderName} | first-module-pass` },
      { moduleName: `${firstFolderName} | second-module-pass` },
    ]);
    assert.failingTestCasesFor(cmd, [
      { moduleName: `${firstFolderName} | first-module-fail` },
      { moduleName: `${firstFolderName} | second-module-fail` },
      { moduleName: `${firstFolderName} | third-module-fail` },
    ]);
    assert.passingTestCasesFor(cmd, [
      { moduleName: `${secondFolderName} | first-module-pass` },
      { moduleName: `${secondFolderName} | second-module-pass` },
    ]);
    assert.outputContains(
      cmd,
      {
        contains: [/actual:\n\s+firstName: Izel/, /expected:\n\s+firstName: Isaac/],
      },
      'deepEqual failure shows structured YAML object diff',
    );
    // firstFolder: 2×3 + 3×4 = 18 tests (9 fail); secondFolder: 2×3 = 6 tests → 24 total, 9 fail
    assert.tapResult(cmd, { testCount: 24, failCount: 9 });
  });

  test('works for a single folder input in browser mode with debug and all passing tests', async (assert, testMetadata) => {
    let folderName = await writeTestFolder({ addFailingTests: false });

    const result = await shell(`node cli.ts tmp/${folderName} --debug`, {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.passingTestCasesFor(result, [
      { debug: true, moduleName: `${folderName} | first-module-pass` },
      { debug: true, moduleName: `${folderName} | second-module-pass` },
    ]);
    assert.tapResult(result, { testCount: 6 });
  });

  test('works for a single folder input in browser mode with debug and few failing tests', async (assert, testMetadata) => {
    let folderName = await writeTestFolder({ addFailingTests: true });

    const cmd = await shellFails(`node cli.ts tmp/${folderName} --debug`, {
      ...moduleMetadata,
      ...testMetadata,
    }); // NOTE: instead of failing it succeeds, maybe due to timeout it fails before actually closing?
    assert.exitCode(cmd, 1, 'expected shell to exit non-zero due to failing tests');
    assert.passingTestCasesFor(cmd, [
      { debug: true, moduleName: `${folderName} | first-module-pass` },
      { debug: true, moduleName: `${folderName} | second-module-pass` },
    ]);
    assert.failingTestCasesFor(cmd, [
      { debug: true, moduleName: `${folderName} | first-module-fail` },
      { debug: true, moduleName: `${folderName} | second-module-fail` },
      { debug: true, moduleName: `${folderName} | third-module-fail` },
    ]);
    assert.tapResult(cmd, { testCount: 18, failCount: 9 });
  });

  test('works for a multiple folders input in browser mode with debug and all passing tests', async (assert, testMetadata) => {
    let firstFolderName = await writeTestFolder({ addFailingTests: false });
    let secondFolderName = await writeTestFolder({ addFailingTests: false });

    const result = await shell(
      `node cli.ts tmp/${firstFolderName} tmp/${secondFolderName} --debug`,
      { ...moduleMetadata, ...testMetadata },
    );

    assert.passingTestCasesFor(result, [
      { debug: true, moduleName: `${firstFolderName} | first-module-pass` },
      { debug: true, moduleName: `${firstFolderName} | second-module-pass` },
      { debug: true, moduleName: `${secondFolderName} | first-module-pass` },
      { debug: true, moduleName: `${secondFolderName} | second-module-pass` },
    ]);
    assert.tapResult(result, { testCount: 12 });
  });

  test('works for a multiple folders input in browser mode with debug and few failing tests', async (assert, testMetadata) => {
    let firstFolderName = await writeTestFolder({ addFailingTests: true });
    let secondFolderName = await writeTestFolder({ addFailingTests: false });

    const cmd = await shellFails(
      `node cli.ts tmp/${firstFolderName} tmp/${secondFolderName} --debug`,
      { ...moduleMetadata, ...testMetadata },
    );
    assert.exitCode(cmd, 1, 'expected shell to exit non-zero due to failing tests');
    assert.passingTestCasesFor(cmd, [
      { debug: true, moduleName: `${firstFolderName} | first-module-pass` },
      { debug: true, moduleName: `${firstFolderName} | second-module-pass` },
    ]);
    assert.failingTestCasesFor(cmd, [
      { debug: true, moduleName: `${firstFolderName} | first-module-fail` },
      { debug: true, moduleName: `${firstFolderName} | second-module-fail` },
      { debug: true, moduleName: `${firstFolderName} | third-module-fail` },
    ]);
    assert.passingTestCasesFor(cmd, [
      { debug: true, moduleName: `${secondFolderName} | first-module-pass` },
      { debug: true, moduleName: `${secondFolderName} | second-module-pass` },
    ]);
    // firstFolder: 2×3 + 3×4 = 18 tests (9 fail); secondFolder: 2×3 = 6 tests → 24 total, 9 fail
    assert.tapResult(cmd, { testCount: 24, failCount: 9 });
  });
});
