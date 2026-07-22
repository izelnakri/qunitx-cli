import { module, test } from 'qunitx';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import '../helpers/custom-asserts.ts';
import { execute as shell, shellFails } from '../helpers/shell.ts';
import { rmRetry } from '../helpers/rm-retry.ts';

// Every reporter's layout — marks, per-status characters, 72-column wrapping, the Failures
// block, the annotation format — is pinned deterministically against synthetic events in
// test/reporters/{spec,dot,github,junit}-test.ts, which own stdout and can assert exactly.
// Flag validation is Args | parse | --reporter validation. What is left for a real browser
// is the wiring those cannot reach: that --reporter=<name> actually installs that reporter
// for a live run, that installing one suppresses TAP, and that a failure's location survives
// the source map back to the original .ts.
module('Flags | --reporter', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('--reporter=<name> installs that reporter and suppresses TAP', async (assert, testMetadata) => {
    const metadata = { ...moduleMetadata, ...testMetadata };
    const [spec, dot] = await Promise.all([
      shell(`node cli.ts test/fixtures/passing-tests.ts --reporter=spec`, metadata),
      shell(`node cli.ts test/fixtures/passing-tests.ts --reporter=dot`, metadata),
    ]);

    assert.outputContains(
      spec,
      {
        contains: [
          'Running 1 test file across 1 worker(s)',
          '{{moduleName}} Passing Tests',
          '3 passing',
        ],
        notContains: ['TAP version 13', 'ok 1 ', '1..3', '# tests 3'],
      },
      'spec owns stdout',
    );
    assert.outputContains(
      dot,
      {
        contains: ['Running 1 test file across 1 worker(s)', '3 passing'],
        notContains: ['TAP version 13', 'ok 1 ', '1..3'],
      },
      'dot owns stdout',
    );
  });

  test('a failure is annotated at its original .ts line, over the spec output', async (assert, testMetadata) => {
    // github composes on top of spec, so one failing run exercises both: spec's failure
    // rendering and github's annotation. The line number is the load-bearing part — it can
    // only be right if the source map resolved the bundle frame back to the fixture.
    const result = await shellFails(
      `node cli.ts test/fixtures/failing-tests.ts --reporter=github`,
      { ...moduleMetadata, ...testMetadata },
    );

    assert.exitCode(result, 1, 'failing run still exits 1');
    assert.outputContains(result, {
      contains: [
        /::error file=test\/fixtures\/failing-tests\.ts,line=\d+,col=\d+,title=/,
        /✖ deepEqual true works/,
        'at test/fixtures/failing-tests.ts:',
        '3 failing',
        'Failures:',
      ],
      notContains: ['not ok 1 ', 'TAP version 13'],
    });
  });

  test('a stdout reporter composes with --junit: it owns stdout, the artifact still lands', async (assert, testMetadata) => {
    const output = `tmp/spec-junit-${randomUUID()}`;
    const result = await shell(
      `node cli.ts test/fixtures/passing-tests.ts --reporter=spec --junit --output=${output}`,
      { ...moduleMetadata, ...testMetadata },
    );

    assert.outputContains(result, {
      contains: ['3 passing', 'wrote JUnit report'],
      notContains: ['TAP version 13'],
    });
    try {
      const xml = await fs.readFile(`${output}/junit.xml`, 'utf8');
      assert.ok(/<testsuites name="qunitx" tests="3"/.test(xml), 'junit artifact still produced');
    } finally {
      await rmRetry(output);
    }
  });
});
