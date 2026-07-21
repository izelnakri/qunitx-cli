import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { rmRetry } from '../helpers/rm-retry.ts';
import { randomUUID } from 'node:crypto';
import '../helpers/custom-asserts.ts';
import { execute as shell } from '../helpers/shell.ts';

// Coverage is V8-precise-coverage over CDP — chromium only. On the firefox/webkit CI lanes we
// assert the warning-and-skip path instead of the report itself.
const IS_CHROMIUM = (process.env.QUNITX_BROWSER || 'chromium') === 'chromium';

module('Flags | --coverage', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('prints a terminal summary and writes lcov + html reports', async (assert, testMetadata) => {
    const output = `tmp/cov-${randomUUID()}`;
    try {
      const result = await shell(
        `node cli.ts test/fixtures/coverage/calculator-test.ts --coverage=lcov,html --output=${output}`,
        { ...moduleMetadata, ...testMetadata },
      );

      if (!IS_CHROMIUM) {
        assert.includes(result, 'requires the chromium browser');
        const dirExists = await fs
          .stat(`${output}/coverage`)
          .then(() => true)
          .catch(() => false);
        assert.notOk(dirExists, 'no coverage dir on non-chromium browsers');
        return;
      }

      assert.includes(result, 'Coverage (V8 line coverage)');
      assert.includes(result, 'calculator.ts');

      const lcov = await fs.readFile(`${output}/coverage/lcov.info`, 'utf8');
      assert.ok(
        lcov.includes('SF:test/fixtures/coverage/calculator.ts'),
        'source-under-test recorded in lcov',
      );
      assert.ok(/DA:\d+,0/.test(lcov), 'has a missed line (the uncovered abs branch)');
      assert.ok(/DA:\d+,[1-9]/.test(lcov), 'has a covered line');
      assert.ok(lcov.includes('end_of_record'), 'lcov record terminated');

      const html = await fs.readFile(`${output}/coverage/index.html`, 'utf8');
      assert.ok(html.includes('qunitx coverage'), 'html report generated');
      assert.ok(/class="ln (hit|miss)"/.test(html), 'html shows line-level hit/miss');
    } finally {
      await rmRetry(output);
    }
  });

  test('excludes test files and node_modules from the report', async (assert, testMetadata) => {
    if (!IS_CHROMIUM) {
      assert.ok(true, 'coverage exclusions only apply on chromium — skipped');
      return;
    }
    const output = `tmp/cov-exclude-${randomUUID()}`;
    try {
      await shell(
        `node cli.ts test/fixtures/coverage/calculator-test.ts --coverage=lcov --output=${output}`,
        { ...moduleMetadata, ...testMetadata },
      );
      const lcov = await fs.readFile(`${output}/coverage/lcov.info`, 'utf8');
      assert.notOk(lcov.includes('calculator-test.ts'), 'test entry file excluded');
      assert.notOk(lcov.includes('node_modules'), 'dependencies excluded');
    } finally {
      await rmRetry(output);
    }
  });

  test('bare --coverage prints the summary without writing report files', async (assert, testMetadata) => {
    const output = `tmp/cov-terminal-${randomUUID()}`;
    try {
      const result = await shell(
        `node cli.ts test/fixtures/coverage/calculator-test.ts --coverage --output=${output}`,
        { ...moduleMetadata, ...testMetadata },
      );
      if (!IS_CHROMIUM) {
        assert.includes(result, 'requires the chromium browser');
        return;
      }
      assert.includes(result, 'Coverage (V8 line coverage)');
      const dirExists = await fs
        .stat(`${output}/coverage`)
        .then(() => true)
        .catch(() => false);
      assert.notOk(dirExists, 'no coverage/ dir for the terminal-only summary');
    } finally {
      await rmRetry(output);
    }
  });
});
