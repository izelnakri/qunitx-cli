import { module, test } from 'qunitx';
import { assertPassingTestCase, assertFailingTestCase, assertTAPResult } from '../helpers/assert-stdout.js';
import shell from '../helpers/shell.js';

module('File Input Tests', { concurrency: false }, (_hooks, moduleMetadata) => {
  test('testing a single passing js file with works, console output supressed', async (assert, testMetadata) => {
    const { stdout } = await shell('node cli.js tmp/test/passing-tests.js', { ...moduleMetadata, ...testMetadata });

    assertPassingTestCase(assert, stdout, { testNo: 1, moduleName: '{{moduleName}}' });
    assertTAPResult(assert, stdout, { testCount: 3 });
  });

  test('testing a single passing ts file works, console output supressed', async (assert, testMetadata) => {
    const { stdout } = await shell('node cli.js tmp/test/passing-tests.ts', { ...moduleMetadata, ...testMetadata });

    assert.ok(stdout.includes('TAP version 13'));
    assertPassingTestCase(assert, stdout, { testNo: 1, moduleName: '{{moduleName}}' });
    assertTAPResult(assert, stdout, { testCount: 3 });
  });

  test('testing a single passing js file with --debug works', async (assert, testMetadata) => {
    const { stdout } = await shell('node cli.js tmp/test/passing-tests.js --debug', { ...moduleMetadata, ...testMetadata });

    assert.ok(new RegExp(/# QUnitX running: http\:\/\/localhost:\d+/).test(stdout));
    assert.ok(stdout.includes('TAP version 13'));
    assertPassingTestCase(assert, stdout, { debug: true, testNo: 1, moduleName: '{{moduleName}}' });
    assertTAPResult(assert, stdout, { testCount: 3 });
  });

  test('testing a single passing ts file with --debug works', async (assert, testMetadata) => {
    const { stdout } = await shell('node cli.js tmp/test/passing-tests.ts --debug', { ...moduleMetadata, ...testMetadata });

    assert.ok(new RegExp(/# QUnitX running: http\:\/\/localhost:\d+/).test(stdout));
    assert.ok(stdout.includes('TAP version 13'));

    assertPassingTestCase(assert, stdout, { debug: true, testNo: 1, moduleName: '{{moduleName}}' });
    assertTAPResult(assert, stdout, { testCount: 3 });
  });

  test('testing a single failing js file works', async (assert, testMetadata) => {
    try {
      let { stdout } = await shell('node cli.js tmp/test/failing-tests.js', { ...moduleMetadata, ...testMetadata });
    } catch(cmd) {
      assert.ok(cmd.stdout.includes('TAP version 13'));
      assertFailingTestCase(assert, cmd.stdout, { testNo: 1, moduleName: '{{moduleName}}' });
      assertTAPResult(assert, cmd.stdout, { testCount: 4, failCount: 3 });
    }
  });

  test('testing a single failing ts file works', async (assert, testMetadata) => {
    try {
      await shell('node cli.js tmp/test/failing-tests.ts', { ...moduleMetadata, ...testMetadata });
    } catch(cmd) {
      assert.ok(cmd.stdout.includes('TAP version 13'));
      assertPassingTestCase(assert, cmd.stdout, { testNo: 1, moduleName: '{{moduleName}}' });
      assertTAPResult(assert, cmd.stdout, { testCount: 4, failCount: 3 });
    }
  });

  test('testing a single failing js file with --debug works', async (assert, testMetadata) => {
    try {
      await shell('node cli.js tmp/test/failing-tests.js --debug', { ...moduleMetadata, ...testMetadata });
    } catch(cmd) {
      assert.ok(cmd.stdout.includes('TAP version 13'));
      assertFailingTestCase(assert, cmd.stdout, { debug: true, testNo: 1, moduleName: '{{moduleName}}' });
      assertTAPResult(assert, cmd.stdout, { testCount: 4, failCount: 3 });
    }
  });

  test('testing a single failing ts file with --debug works', async (assert, testMetadata) => {
    try {
      await shell('node cli.js tmp/test/failing-tests.ts --debug', { ...moduleMetadata, ...testMetadata });
    } catch(cmd) {
      assert.ok(cmd.stdout.includes('TAP version 13'));
      assertPassingTestCase(assert, cmd.stdout, { debug: true, testNo: 1, moduleName: '{{moduleName}}' });
      assertTAPResult(assert, cmd.stdout, { testCount: 4, failCount: 3 });
    }
  });
});
