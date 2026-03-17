import { module, test } from 'qunitx';
import { writeTestFolder } from '../helpers/fs-writers.js';
import {
  assertPassingTestCase,
  assertFailingTestCase,
  assertTAPResult,
} from '../helpers/assert-stdout.js';
import shell from '../helpers/shell.js';

module('File and Folder Combination Tests', (_hooks, moduleMetadata) => {
  test('runs a file and a folder together when all tests pass', async (assert, testMetadata) => {
    const folderName = await writeTestFolder({ addFailingTests: false });

    const { stdout } = await shell(`node cli.js tmp/${folderName} tmp/test/passing-tests.js`, {
      ...moduleMetadata,
      ...testMetadata,
    });

    assertPassingTestCase(assert, stdout, { moduleName: `${folderName} | first-module-pass` });
    assertPassingTestCase(assert, stdout, { moduleName: `${folderName} | second-module-pass` });
    assertPassingTestCase(assert, stdout, { moduleName: '{{moduleName}}' });
    // folder: 2 files × 3 tests = 6; extra file: 3 tests → 9 total
    assertTAPResult(assert, stdout, { testCount: 9 });
  });

  test('runs a file and a folder together when the folder has failing tests', async (assert, testMetadata) => {
    const folderName = await writeTestFolder({ addFailingTests: true });

    try {
      await shell(`node cli.js tmp/${folderName} tmp/test/passing-tests.js`, {
        ...moduleMetadata,
        ...testMetadata,
      });
    } catch (cmd) {
      assertPassingTestCase(assert, cmd.stdout, {
        moduleName: `${folderName} | first-module-pass`,
      });
      assertPassingTestCase(assert, cmd.stdout, {
        moduleName: `${folderName} | second-module-pass`,
      });
      assertFailingTestCase(assert, cmd.stdout, {
        moduleName: `${folderName} | first-module-fail`,
      });
      assertFailingTestCase(assert, cmd.stdout, {
        moduleName: `${folderName} | second-module-fail`,
      });
      assertFailingTestCase(assert, cmd.stdout, {
        moduleName: `${folderName} | third-module-fail`,
      });
      // folder (addFailingTests:true): 2 passing files×3 + 3 failing files×4 = 18 tests (9 pass, 9 fail)
      // extra passing-tests.js: 3 tests → grand total 21 tests (12 pass, 9 fail)
      assertTAPResult(assert, cmd.stdout, { testCount: 21, failCount: 9 });
    }
  });
});
