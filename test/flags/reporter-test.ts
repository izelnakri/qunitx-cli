import { module, test } from 'qunitx';
import { randomUUID } from 'node:crypto';
import '../helpers/custom-asserts.ts';
import { execute as shell, shellFails } from '../helpers/shell.ts';
import { rmRetry } from '../helpers/rm-retry.ts';

module('--reporter', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('tap is the default: TAP still streams with no flag', async (assert, testMetadata) => {
    const result = await shell(
      `node cli.ts test/fixtures/passing-tests.ts --output=tmp/rep-${randomUUID()}`,
      { ...moduleMetadata, ...testMetadata },
    );
    assert.includes(result, 'TAP version 13');
    assert.tapResult(result, { testCount: 3 });
  });

  test('an unknown reporter fails fast and lists the valid values', async (assert) => {
    const result = await shellFails(
      `node cli.ts test/fixtures/passing-tests.ts --reporter=nope --output=tmp/rep-${randomUUID()}`,
    );
    assert.exitCode(result, 1);
    assert.ok(
      /Invalid --reporter value: "nope"\. Must be one of: tap, spec, dot, github/.test(
        result.stderr ?? '',
      ),
      'error names the value and the valid set',
    );
  });

  test('--reporter with no value is rejected rather than silently defaulting', async (assert) => {
    const result = await shellFails(
      `node cli.ts test/fixtures/passing-tests.ts --reporter --output=tmp/rep-${randomUUID()}`,
    );
    assert.exitCode(result, 1);
    assert.ok(/Invalid --reporter value/.test(result.stderr ?? ''), 'empty value is an error');
  });
});

module('--reporter=spec', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('renders module-grouped results and a summary instead of TAP', async (assert, testMetadata) => {
    const result = await shell(
      `node cli.ts test/fixtures/passing-tests.ts --reporter=spec --output=tmp/spec-${randomUUID()}`,
      { ...moduleMetadata, ...testMetadata },
    );

    assert.outputContains(result, {
      contains: [
        'Running 1 test file across 1 worker(s)',
        '{{moduleName}} Passing Tests',
        /✔ assert true works \(\d+ms\)/,
        '3 passing',
      ],
      // The stdout format is owned by spec: no TAP syntax, and no TAP `#` comments.
      notContains: ['TAP version 13', 'ok 1 ', '1..3', '# tests 3', '# QUnitX running'],
    });
  });

  test('failures show the source-mapped location inline and exit non-zero', async (assert, testMetadata) => {
    const result = await shellFails(
      `node cli.ts test/fixtures/failing-tests.ts --reporter=spec --output=tmp/spec-${randomUUID()}`,
      { ...moduleMetadata, ...testMetadata },
    );
    assert.exitCode(result, 1, 'failing run still exits 1');
    assert.outputContains(result, {
      contains: [
        /✖ deepEqual true works/,
        'at test/fixtures/failing-tests.ts:',
        '3 failing',
        'Failures:',
      ],
      notContains: ['not ok 1 ', 'TAP version 13'],
    });
  });

  test('skipped and todo tests are marked and counted', async (assert, testMetadata) => {
    const result = await shell(
      `node cli.ts test/fixtures/skip-todo-tests.ts --reporter=spec --output=tmp/spec-${randomUUID()}`,
      { ...moduleMetadata, ...testMetadata },
    );
    assert.outputContains(result, {
      contains: ['- skipped test is not executed', '◌ todo test is expected to fail', '1 skipped'],
    });
  });

  test('composes with --junit: spec owns stdout, junit.xml is still written', async (assert, testMetadata) => {
    const output = `tmp/spec-junit-${randomUUID()}`;
    const result = await shell(
      `node cli.ts test/fixtures/passing-tests.ts --reporter=spec --junit --output=${output}`,
      { ...moduleMetadata, ...testMetadata },
    );
    assert.outputContains(result, {
      contains: ['3 passing', 'wrote JUnit report'],
      notContains: ['TAP version 13'],
    });
    const fs = await import('node:fs/promises');
    try {
      const xml = await fs.readFile(`${output}/junit.xml`, 'utf8');
      assert.ok(/<testsuites name="qunitx" tests="3"/.test(xml), 'junit artifact still produced');
    } finally {
      await rmRetry(output);
    }
  });
});

// These assert dot's wiring, not its layout. The matrix is the one piece of output that leaves
// its line open, so anything else the run prints lands on it: browser console warnings are
// forwarded to stdout unconditionally (browser.ts `alwaysShow`) and arrive asynchronously —
// Firefox emits one from the bundle on every run, so the matrix line legitimately reads
// `...[JavaScript Warning: …]`, and under load the dots can split across lines. That's inherent
// to a one-char-per-test format (mocha/vitest included). Exact marks, per-status characters and
// 72-column wrapping are pinned deterministically in test/reporters/dot-test.ts, which owns
// stdout and can assert them exactly.
module('--reporter=dot', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('reports a run through the dot summary rather than TAP', async (assert, testMetadata) => {
    const result = await shell(
      `node cli.ts test/fixtures/passing-tests.ts --reporter=dot --output=tmp/dot-${randomUUID()}`,
      { ...moduleMetadata, ...testMetadata },
    );
    assert.outputContains(result, {
      contains: ['Running 1 test file across 1 worker(s)', '3 passing'],
      notContains: ['TAP version 13', 'ok 1 ', '1..3', '# QUnitX running'],
    });
  });

  test('failures are counted and detailed at the end', async (assert, testMetadata) => {
    const result = await shellFails(
      `node cli.ts test/fixtures/failing-tests.ts --reporter=dot --output=tmp/dot-${randomUUID()}`,
      { ...moduleMetadata, ...testMetadata },
    );
    assert.exitCode(result, 1, 'failing run still exits 1');
    assert.outputContains(result, {
      contains: [
        '1 passing',
        '3 failing',
        'Failures:',
        '1) {{moduleName}} Failing Tests | async test finishes',
        'at test/fixtures/failing-tests.ts:',
      ],
      notContains: ['not ok 1 ', 'TAP version 13'],
    });
  });

  test('composes with --junit: dot owns stdout, junit.xml is still written', async (assert, testMetadata) => {
    const output = `tmp/dot-junit-${randomUUID()}`;
    const result = await shell(
      `node cli.ts test/fixtures/passing-tests.ts --reporter=dot --junit --output=${output}`,
      { ...moduleMetadata, ...testMetadata },
    );
    assert.outputContains(result, {
      contains: ['3 passing', 'wrote JUnit report'],
      notContains: ['TAP version 13'],
    });
    const fs = await import('node:fs/promises');
    try {
      const xml = await fs.readFile(`${output}/junit.xml`, 'utf8');
      assert.ok(/<testsuites name="qunitx" tests="3"/.test(xml), 'junit artifact still produced');
    } finally {
      await rmRetry(output);
    }
  });
});

module('--reporter=github', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('annotates failures at their original source line, on top of spec output', async (assert, testMetadata) => {
    const result = await shellFails(
      `node cli.ts test/fixtures/failing-tests.ts --reporter=github --output=tmp/gh-${randomUUID()}`,
      { ...moduleMetadata, ...testMetadata },
    );
    assert.exitCode(result, 1, 'failing run still exits 1');
    assert.outputContains(result, {
      contains: [
        // Annotation points at the original .ts source, not the bundle — the source map is
        // already resolved by the shared failure descriptor.
        /::error file=test\/fixtures\/failing-tests\.ts,line=\d+,col=\d+,title=/,
        '3 failing', // spec output is still there
        /✖ deepEqual true works/,
      ],
      notContains: ['TAP version 13'],
    });
  });

  test('a passing run emits no annotations', async (assert, testMetadata) => {
    const result = await shell(
      `node cli.ts test/fixtures/passing-tests.ts --reporter=github --output=tmp/gh-${randomUUID()}`,
      { ...moduleMetadata, ...testMetadata },
    );
    assert.outputContains(result, {
      contains: ['3 passing'],
      notContains: ['::error'],
    });
  });
});
