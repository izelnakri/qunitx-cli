import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import '../helpers/custom-asserts.ts';
import shell from '../helpers/shell.ts';

module('--output flag tests for browser mode', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('--output changes the output directory for built files', async (assert, testMetadata) => {
    const customOutput = `tmp/custom-output-${randomUUID()}`;

    try {
      const result = await shell(
        `node cli.ts test/fixtures/passing-tests.js --output=${customOutput}`,
        {
          ...moduleMetadata,
          ...testMetadata,
        },
      );

      assert.passingTestCaseFor(result, { testNo: 1, moduleName: '{{moduleName}}' });
      assert.tapResult(result, { testCount: 3 });

      const [indexStat, testsStat] = await Promise.allSettled([
        fs.stat(`${customOutput}/index.html`),
        fs.stat(`${customOutput}/tests.js`),
      ]);

      assert.ok(indexStat.value, 'index.html was written to custom output directory');
      assert.ok(testsStat.value, 'tests.js was written to custom output directory');
    } finally {
      await fs.rm(customOutput, { recursive: true, force: true });
    }
  });
});
