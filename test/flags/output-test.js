import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { assertPassingTestCase, assertTAPResult } from '../helpers/assert-stdout.js';
import shell from '../helpers/shell.js';

module('--output flag tests for browser mode', (_hooks, moduleMetadata) => {
  test('--output changes the output directory for built files', async (assert, testMetadata) => {
    let customOutput = 'tmp/custom-output-test';

    try {
      await fs.rm(customOutput, { recursive: true, force: true });
    } catch (_) {}

    const { stdout } = await shell(
      `node cli.js tmp/test/passing-tests.js --output=${customOutput}`,
      { ...moduleMetadata, ...testMetadata },
    );

    assertPassingTestCase(assert, stdout, { testNo: 1, moduleName: '{{moduleName}}' });
    assertTAPResult(assert, stdout, { testCount: 3 });

    const indexExists = await fs
      .stat(`${customOutput}/index.html`)
      .then(() => true)
      .catch(() => false);
    const testsJsExists = await fs
      .stat(`${customOutput}/tests.js`)
      .then(() => true)
      .catch(() => false);

    assert.ok(indexExists, 'index.html was written to custom output directory');
    assert.ok(testsJsExists, 'tests.js was written to custom output directory');

    await fs.rm(customOutput, { recursive: true, force: true });
  });
});
