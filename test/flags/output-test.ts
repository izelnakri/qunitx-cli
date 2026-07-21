import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { rmRetry } from '../helpers/rm-retry.ts';
import { randomUUID } from 'node:crypto';
import '../helpers/custom-asserts.ts';
import { execute as shell } from '../helpers/shell.ts';

module('Flags | --output', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('writes the built index.html and tests.js into the given directory', async (assert, testMetadata) => {
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
      await rmRetry(customOutput);
    }
  });
});
