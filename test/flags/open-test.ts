import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import '../helpers/custom-asserts.ts';
import { execute as shell } from '../helpers/shell.ts';

module('Flags | --open', { concurrency: true }, (_hooks, moduleMetadata) => {
  // One run covers everything --open changes end to end: the suite still runs headlessly to a
  // full TAP result, and the bundle is materialised on disk (tests-in-browser.ts `needsDisk`)
  // so the browser that gets opened has something to serve. `echo` stands in for the browser
  // binary — it accepts the URL argument and exits cleanly on every OS, and never competes
  // with Playwright's own browser for CI cores.
  //
  // Flag parsing (-o, -o=<value>, --open=false, --open=<binary>) shares one branch in
  // lib/args/parse.ts and is owned by test/args/parse-test.ts 'Args | parse | --open'.
  test('runs headlessly to a full TAP result and writes the static output files', async (assert, testMetadata) => {
    const output = `tmp/open-output-${randomUUID()}`;
    const result = await shell(
      `node cli.ts test/fixtures/passing-tests.js --open=echo --output=${output}`,
      { ...moduleMetadata, ...testMetadata },
    );

    assert.passingTestCaseFor(result, { testNo: 1, moduleName: '{{moduleName}}' });
    assert.tapResult(result, { testCount: 3 });

    const [indexStat, testsStat] = await Promise.allSettled([
      fs.stat(`${output}/index.html`),
      fs.stat(`${output}/tests.js`),
    ]);

    assert.ok(indexStat.status === 'fulfilled', 'index.html was written to the output directory');
    assert.ok(testsStat.status === 'fulfilled', 'tests.js was written to the output directory');
  });
});
