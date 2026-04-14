import { module, test } from 'qunitx';
import { writeTestFolder, writeNestedTestFolder } from '../helpers/fs-writers.ts';
import '../helpers/custom-asserts.ts';
import shell, { shellFails } from '../helpers/shell.ts';

module('Folder Input Tests', { concurrency: true }, (_hooks, moduleMetadata) => {
  // Each paired test runs two `node cli.ts` invocations concurrently via Promise.all on the
  // same temp folder (read-only for both). Both semaphore slots are acquired simultaneously,
  // so wall time = max(a, b) not a + b, and only one writeTestFolder() call is needed.

  test('discovers and runs test files in nested subdirectories', async (assert, testMetadata) => {
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

  test('single folder, all passing: without and with --debug', async (assert, testMetadata) => {
    const folderName = await writeTestFolder({ addFailingTests: false });

    const [result, debugResult] = await Promise.all([
      shell(`node cli.ts tmp/${folderName}`, { ...moduleMetadata, ...testMetadata }),
      shell(`node cli.ts tmp/${folderName} --debug`, { ...moduleMetadata, ...testMetadata }),
    ]);

    assert.passingTestCasesFor(result, [
      { moduleName: `${folderName} | first-module-pass` },
      { moduleName: `${folderName} | second-module-pass` },
    ]);
    assert.tapResult(result, { testCount: 6 });

    assert.hasDebugURL(debugResult);
    assert.passingTestCasesFor(debugResult, [
      { debug: true, moduleName: `${folderName} | first-module-pass` },
      { debug: true, moduleName: `${folderName} | second-module-pass` },
    ]);
    assert.tapResult(debugResult, { testCount: 6 });
  });

  test('single folder, failing tests: without and with --debug', async (assert, testMetadata) => {
    const folderName = await writeTestFolder({ addFailingTests: true });

    const [cmd, debugCmd] = await Promise.all([
      shellFails(`node cli.ts tmp/${folderName}`, { ...moduleMetadata, ...testMetadata }),
      shellFails(`node cli.ts tmp/${folderName} --debug`, { ...moduleMetadata, ...testMetadata }),
    ]);

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

    assert.exitCode(
      debugCmd,
      1,
      'debug mode: expected shell to exit non-zero due to failing tests',
    );
    assert.passingTestCasesFor(debugCmd, [
      { debug: true, moduleName: `${folderName} | first-module-pass` },
      { debug: true, moduleName: `${folderName} | second-module-pass` },
    ]);
    assert.failingTestCasesFor(debugCmd, [
      { debug: true, moduleName: `${folderName} | first-module-fail` },
      { debug: true, moduleName: `${folderName} | second-module-fail` },
      { debug: true, moduleName: `${folderName} | third-module-fail` },
    ]);
    assert.tapResult(debugCmd, { testCount: 18, failCount: 9 });
  });

  test('multiple folders, all passing: without and with --debug', async (assert, testMetadata) => {
    const [firstFolderName, secondFolderName] = await Promise.all([
      writeTestFolder({ addFailingTests: false }),
      writeTestFolder({ addFailingTests: false }),
    ]);

    const [result, debugResult] = await Promise.all([
      shell(`node cli.ts tmp/${firstFolderName} tmp/${secondFolderName}`, {
        ...moduleMetadata,
        ...testMetadata,
      }),
      shell(`node cli.ts tmp/${firstFolderName} tmp/${secondFolderName} --debug`, {
        ...moduleMetadata,
        ...testMetadata,
      }),
    ]);

    assert.passingTestCasesFor(result, [
      { moduleName: `${firstFolderName} | first-module-pass` },
      { moduleName: `${firstFolderName} | second-module-pass` },
      { moduleName: `${secondFolderName} | first-module-pass` },
      { moduleName: `${secondFolderName} | second-module-pass` },
    ]);
    assert.tapResult(result, { testCount: 12 });

    assert.hasDebugURL(debugResult);
    assert.passingTestCasesFor(debugResult, [
      { debug: true, moduleName: `${firstFolderName} | first-module-pass` },
      { debug: true, moduleName: `${firstFolderName} | second-module-pass` },
      { debug: true, moduleName: `${secondFolderName} | first-module-pass` },
      { debug: true, moduleName: `${secondFolderName} | second-module-pass` },
    ]);
    assert.tapResult(debugResult, { testCount: 12 });
  });

  test('multiple folders, failing tests: without and with --debug', async (assert, testMetadata) => {
    const [firstFolderName, secondFolderName] = await Promise.all([
      writeTestFolder({ addFailingTests: true }),
      writeTestFolder({ addFailingTests: false }),
    ]);

    const [cmd, debugCmd] = await Promise.all([
      shellFails(`node cli.ts tmp/${firstFolderName} tmp/${secondFolderName}`, {
        ...moduleMetadata,
        ...testMetadata,
      }),
      shellFails(`node cli.ts tmp/${firstFolderName} tmp/${secondFolderName} --debug`, {
        ...moduleMetadata,
        ...testMetadata,
      }),
    ]);

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
      { contains: [/actual:\n\s+firstName: Izel/, /expected:\n\s+firstName: Isaac/] },
      'deepEqual failure shows structured YAML object diff',
    );
    // firstFolder: 2×3 + 3×4 = 18 tests (9 fail); secondFolder: 2×3 = 6 tests → 24 total, 9 fail
    assert.tapResult(cmd, { testCount: 24, failCount: 9 });

    assert.exitCode(
      debugCmd,
      1,
      'debug mode: expected shell to exit non-zero due to failing tests',
    );
    assert.passingTestCasesFor(debugCmd, [
      { debug: true, moduleName: `${firstFolderName} | first-module-pass` },
      { debug: true, moduleName: `${firstFolderName} | second-module-pass` },
    ]);
    assert.failingTestCasesFor(debugCmd, [
      { debug: true, moduleName: `${firstFolderName} | first-module-fail` },
      { debug: true, moduleName: `${firstFolderName} | second-module-fail` },
      { debug: true, moduleName: `${firstFolderName} | third-module-fail` },
    ]);
    assert.passingTestCasesFor(debugCmd, [
      { debug: true, moduleName: `${secondFolderName} | first-module-pass` },
      { debug: true, moduleName: `${secondFolderName} | second-module-pass` },
    ]);
    // firstFolder: 2×3 + 3×4 = 18 tests (9 fail); secondFolder: 2×3 = 6 tests → 24 total, 9 fail
    assert.tapResult(debugCmd, { testCount: 24, failCount: 9 });
  });
});
