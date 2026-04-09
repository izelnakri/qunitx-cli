import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import '../helpers/custom-asserts.ts';
import execute from '../helpers/shell.ts';

module('--open flag tests', (_hooks, moduleMetadata) => {
  test('--open runs tests headlessly and exits normally with TAP output', async (assert, testMetadata) => {
    const result = await execute(`node cli.ts tmp/test/passing-tests.js --open`, {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.passingTestCaseFor(result, { testNo: 1, moduleName: '{{moduleName}}' });
    assert.tapResult(result, { testCount: 3 });
  });

  test('--open writes static output files', async (assert, testMetadata) => {
    const { randomUUID } = await import('node:crypto');
    const customOutput = `tmp/open-output-${randomUUID()}`;

    await execute(`node cli.ts tmp/test/passing-tests.js --open --output=${customOutput}`, {
      ...moduleMetadata,
      ...testMetadata,
    });

    const [indexStat, testsStat] = await Promise.allSettled([
      fs.stat(`${customOutput}/index.html`),
      fs.stat(`${customOutput}/tests.js`),
    ]);

    assert.ok(indexStat.value, 'index.html was written to output directory');
    assert.ok(testsStat.value, 'tests.js was written to output directory');
  });

  test('-o shorthand works the same as --open', async (assert, testMetadata) => {
    const result = await execute(`node cli.ts tmp/test/passing-tests.js -o`, {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.tapResult(result, { testCount: 3 });
  });

  test('--open=<binary> accepts a custom browser binary and tests still complete', async (assert, testMetadata) => {
    // Use `echo` as a stand-in binary — it accepts any argument and exits cleanly,
    // so the test runs on any OS without a real browser installed under that name.
    // The key assertion is that the CLI parses the value, does not crash, and tests run normally.
    const result = await execute(`node cli.ts tmp/test/passing-tests.js --open=echo`, {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.tapResult(result, { testCount: 3 });
  });
});
