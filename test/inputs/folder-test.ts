import { module, test } from 'qunitx';
import { writeTestFolder } from '../helpers/fs-writers.ts';
import {
  assertPassingTestCasesFor,
  assertFailingTestCase,
  assertTAPResult,
} from '../helpers/custom-asserts.ts';
import shell, { shellFails } from '../helpers/shell.ts';

module('Folder Input Tests', (_hooks, moduleMetadata) => {
  test('works for a single folder input in browser mode with all passing tests', async (assert, testMetadata) => {
    let folderName = await writeTestFolder({ addFailingTests: false });

    const result = await shell(`node cli.ts tmp/${folderName}`, {
      ...moduleMetadata,
      ...testMetadata,
    });

    assertPassingTestCasesFor(assert, result, {
      debug: false,
      moduleName: `${folderName} | first-module-pass`,
    });
    assertPassingTestCasesFor(assert, result, {
      debug: false,
      moduleName: `${folderName} | second-module-pass`,
    });
    assertTAPResult(assert, result, { testCount: 6 });
  });

  test('works for a single folder input in browser mode with few failing tests', async (assert, testMetadata) => {
    let folderName = await writeTestFolder({ addFailingTests: true });

    const cmd = await shellFails(`node cli.ts tmp/${folderName}`, {
      ...moduleMetadata,
      ...testMetadata,
    });
    assert.exitCode(cmd, 1, 'expected shell to exit non-zero due to failing tests');
    assertPassingTestCasesFor(assert, cmd, {
      debug: false,
      moduleName: `${folderName} | first-module-pass`,
    });
    assertPassingTestCasesFor(assert, cmd, {
      debug: false,
      moduleName: `${folderName} | second-module-pass`,
    });
    assertFailingTestCase(assert, cmd, {
      debug: false,
      moduleName: `${folderName} | first-module-fail`,
    });
    assertFailingTestCase(assert, cmd, {
      debug: false,
      moduleName: `${folderName} | second-module-fail`,
    });
    assertFailingTestCase(assert, cmd, {
      debug: false,
      moduleName: `${folderName} | third-module-fail`,
    });
    assert.outputContains(
      cmd,
      {
        contains: [/actual:\n\s+firstName: Izel/, /expected:\n\s+firstName: Isaac/],
      },
      'deepEqual failure shows structured YAML object diff',
    );
    assertTAPResult(assert, cmd, { testCount: 18, failCount: 9 });
  });

  test('works for a multiple folders input in browser mode with all passing tests', async (assert, testMetadata) => {
    let firstFolderName = await writeTestFolder({ addFailingTests: false });
    let secondFolderName = await writeTestFolder({ addFailingTests: false });

    const result = await shell(`node cli.ts tmp/${firstFolderName} tmp/${secondFolderName}`, {
      ...moduleMetadata,
      ...testMetadata,
    });

    assertPassingTestCasesFor(assert, result, {
      debug: false,
      moduleName: `${firstFolderName} | first-module-pass`,
    });
    assertPassingTestCasesFor(assert, result, {
      debug: false,
      moduleName: `${firstFolderName} | second-module-pass`,
    });
    assertPassingTestCasesFor(assert, result, {
      debug: false,
      moduleName: `${secondFolderName} | first-module-pass`,
    });
    assertPassingTestCasesFor(assert, result, {
      debug: false,
      moduleName: `${secondFolderName} | second-module-pass`,
    });
    assertTAPResult(assert, result, { testCount: 12 });
  });

  test('works for a multiple folders input in browser mode with few failing tests', async (assert, testMetadata) => {
    let firstFolderName = await writeTestFolder({ addFailingTests: true });
    let secondFolderName = await writeTestFolder({ addFailingTests: false });

    const cmd = await shellFails(`node cli.ts tmp/${firstFolderName} tmp/${secondFolderName}`, {
      ...moduleMetadata,
      ...testMetadata,
    });
    assert.exitCode(cmd, 1, 'expected shell to exit non-zero due to failing tests');
    assertPassingTestCasesFor(assert, cmd, {
      moduleName: `${firstFolderName} | first-module-pass`,
    });
    assertPassingTestCasesFor(assert, cmd, {
      moduleName: `${firstFolderName} | second-module-pass`,
    });
    assertFailingTestCase(assert, cmd, { moduleName: `${firstFolderName} | first-module-fail` });
    assertFailingTestCase(assert, cmd, { moduleName: `${firstFolderName} | second-module-fail` });
    assertFailingTestCase(assert, cmd, { moduleName: `${firstFolderName} | third-module-fail` });
    assertPassingTestCasesFor(assert, cmd, {
      moduleName: `${secondFolderName} | first-module-pass`,
    });
    assertPassingTestCasesFor(assert, cmd, {
      moduleName: `${secondFolderName} | second-module-pass`,
    });
    assert.outputContains(
      cmd,
      {
        contains: [/actual:\n\s+firstName: Izel/, /expected:\n\s+firstName: Isaac/],
      },
      'deepEqual failure shows structured YAML object diff',
    );
    // firstFolder: 2×3 + 3×4 = 18 tests (9 fail); secondFolder: 2×3 = 6 tests → 24 total, 9 fail
    assertTAPResult(assert, cmd, { testCount: 24, failCount: 9 });
  });

  test('works for a single folder input in browser mode with debug and all passing tests', async (assert, testMetadata) => {
    let folderName = await writeTestFolder({ addFailingTests: false });

    const result = await shell(`node cli.ts tmp/${folderName} --debug`, {
      ...moduleMetadata,
      ...testMetadata,
    });

    assertPassingTestCasesFor(assert, result, {
      debug: true,
      moduleName: `${folderName} | first-module-pass`,
    });
    assertPassingTestCasesFor(assert, result, {
      debug: true,
      moduleName: `${folderName} | second-module-pass`,
    });
    assertTAPResult(assert, result, { testCount: 6 });
  });

  test('works for a single folder input in browser mode with debug and few failing tests', async (assert, testMetadata) => {
    let folderName = await writeTestFolder({ addFailingTests: true });

    const cmd = await shellFails(`node cli.ts tmp/${folderName} --debug`, {
      ...moduleMetadata,
      ...testMetadata,
    }); // NOTE: instead of failing it succeeds, maybe due to timeout it fails before actually closing?
    assert.exitCode(cmd, 1, 'expected shell to exit non-zero due to failing tests');

    assertPassingTestCasesFor(assert, cmd, {
      debug: true,
      moduleName: `${folderName} | first-module-pass`,
    });
    assertPassingTestCasesFor(assert, cmd, {
      debug: true,
      moduleName: `${folderName} | second-module-pass`,
    });
    assertFailingTestCase(assert, cmd, {
      debug: true,
      moduleName: `${folderName} | first-module-fail`,
    });
    assertFailingTestCase(assert, cmd, {
      debug: true,
      moduleName: `${folderName} | second-module-fail`,
    });
    assertFailingTestCase(assert, cmd, {
      debug: true,
      moduleName: `${folderName} | third-module-fail`,
    });
    assertTAPResult(assert, cmd, { testCount: 18, failCount: 9 });
  });

  test('works for a multiple folders input in browser mode with debug and all passing tests', async (assert, testMetadata) => {
    let firstFolderName = await writeTestFolder({ addFailingTests: false });
    let secondFolderName = await writeTestFolder({ addFailingTests: false });

    const result = await shell(
      `node cli.ts tmp/${firstFolderName} tmp/${secondFolderName} --debug`,
      { ...moduleMetadata, ...testMetadata },
    );

    assertPassingTestCasesFor(assert, result, {
      debug: true,
      moduleName: `${firstFolderName} | first-module-pass`,
    });
    assertPassingTestCasesFor(assert, result, {
      debug: true,
      moduleName: `${firstFolderName} | second-module-pass`,
    });
    assertPassingTestCasesFor(assert, result, {
      debug: true,
      moduleName: `${secondFolderName} | first-module-pass`,
    });
    assertPassingTestCasesFor(assert, result, {
      debug: true,
      moduleName: `${secondFolderName} | second-module-pass`,
    });
    assertTAPResult(assert, result, { testCount: 12 });
  });

  test('works for a multiple folders input in browser mode with debug and few failing tests', async (assert, testMetadata) => {
    let firstFolderName = await writeTestFolder({ addFailingTests: true });
    let secondFolderName = await writeTestFolder({ addFailingTests: false });

    const cmd = await shellFails(
      `node cli.ts tmp/${firstFolderName} tmp/${secondFolderName} --debug`,
      { ...moduleMetadata, ...testMetadata },
    );
    assert.exitCode(cmd, 1, 'expected shell to exit non-zero due to failing tests');
    assertPassingTestCasesFor(assert, cmd, {
      debug: true,
      moduleName: `${firstFolderName} | first-module-pass`,
    });
    assertPassingTestCasesFor(assert, cmd, {
      debug: true,
      moduleName: `${firstFolderName} | second-module-pass`,
    });
    assertFailingTestCase(assert, cmd, {
      debug: true,
      moduleName: `${firstFolderName} | first-module-fail`,
    });
    assertFailingTestCase(assert, cmd, {
      debug: true,
      moduleName: `${firstFolderName} | second-module-fail`,
    });
    assertFailingTestCase(assert, cmd, {
      debug: true,
      moduleName: `${firstFolderName} | third-module-fail`,
    });
    assertPassingTestCasesFor(assert, cmd, {
      debug: true,
      moduleName: `${secondFolderName} | first-module-pass`,
    });
    assertPassingTestCasesFor(assert, cmd, {
      debug: true,
      moduleName: `${secondFolderName} | second-module-pass`,
    });
    // firstFolder: 2×3 + 3×4 = 18 tests (9 fail); secondFolder: 2×3 = 6 tests → 24 total, 9 fail
    assertTAPResult(assert, cmd, { testCount: 24, failCount: 9 });
  });
});
