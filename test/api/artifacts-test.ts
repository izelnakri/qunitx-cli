import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import { testRun } from './helpers.ts';
import type { RunResult } from '../../lib/api/test.ts';
import '../helpers/custom-asserts.ts';

const PASSING = 'test/fixtures/passing-tests.ts';
const COVERED = 'test/fixtures/coverage/calculator-test.ts';

// Two pairs of tests each read a different facet of one finished run; the assertions are reads,
// so a second browser per pair would buy nothing. Lazy, so a filtered run launches only its own.
let bare: Promise<RunResult> | null = null;
const bareRun = (): Promise<RunResult> => (bare ??= testRun({ inputs: [PASSING] }));
let covered: Promise<RunResult> | null = null;
const coveredRun = (): Promise<RunResult> =>
  (covered ??= testRun({ inputs: [COVERED], coverage: true }));

module('API | artifacts | junit', { concurrency: true }, () => {
  test('the XML comes back on the result, not only as a file', async (assert) => {
    const result = await testRun({ inputs: [PASSING], junit: true });

    assert.ok(result.junitXml, 'the document is on the result');
    assert.includes(result.junitXml!, '<?xml');
    assert.includes(result.junitXml!, '<testsuites');
    assert.includes(result.junitXml!, 'assert true works');
  });

  test('and is still written to disk, byte-identical', async (assert) => {
    const output = `tmp/api-junit-${crypto.randomUUID()}`;
    const result = await testRun({ inputs: [PASSING], junit: true, output });

    const onDisk = await fs.readFile(path.join(output, 'junit.xml'), 'utf8');
    assert.equal(onDisk, result.junitXml, 'the same document, two ways to reach it');
    await fs.rm(output, { recursive: true, force: true });
  });

  test('no junit option means no document', async (assert) => {
    const result = await bareRun();

    assert.equal(result.junitXml, null);
  });
});

module('API | artifacts | coverage', { concurrency: true }, () => {
  test('per-file line coverage comes back as data', async (assert) => {
    const result = await coveredRun();

    assert.ok(result.coverage, 'a summary is present when coverage was asked for');
    assert.true(result.coverage!.files.length > 0, 'with at least one source file');
    assert.true(
      result.coverage!.files.every(
        (file) => file.coverableLines > 0 && file.percent >= 0 && file.percent <= 100,
      ),
      'each file reports sane counts',
    );
    assert.true(
      result.coverage!.coverableLines >= result.coverage!.coveredLines,
      'you cannot cover more lines than exist',
    );
  });

  test('the test file itself is excluded from the report', async (assert) => {
    const result = await coveredRun();

    assert.false(
      result.coverage!.files.some((file) => file.path.endsWith('calculator-test.ts')),
      'a test file covering itself is noise',
    );
    assert.true(result.coverage!.files.some((file) => file.path.endsWith('calculator.ts')));
  });

  test('no coverage option means no summary', async (assert) => {
    const result = await bareRun();

    assert.equal(result.coverage, null);
  });
});
