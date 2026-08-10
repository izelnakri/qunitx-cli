import { module, test } from 'qunitx';
import { DotReporter } from '../../lib/reporters/dot.ts';
import type { TestDetails } from '../../lib/reporters/types.ts';
import '../helpers/custom-asserts.ts';
import { captureStdout } from '../helpers/capture-stdout.ts';
import { feed, makeContext } from '../helpers/reporter-context.ts';

// Colors are disabled in a non-TTY (see lib/utils/color.ts), so these match plain characters.
const passing = (name = 't'): TestDetails => ({
  status: 'passed',
  fullName: ['Mod', name],
  runtime: 1,
  assertions: [],
});

const failing = (name = 'bad'): TestDetails => ({
  status: 'failed',
  fullName: ['Mod', name],
  runtime: 2,
  assertions: [{ passed: false, todo: false, actual: 1, expected: 2, message: 'nope' }],
});

module('Reporters | DotReporter', { concurrency: true }, () => {
  test('emits one character per test, by status', (assert) => {
    const context = makeContext();
    const reporter = new DotReporter();
    assert.strictEqual(feed(reporter, context, passing()), '.', 'pass is a dot');
    assert.strictEqual(feed(reporter, context, failing()), 'F', 'fail is F');
    assert.strictEqual(
      feed(reporter, context, { status: 'skipped', fullName: ['Mod', 's'], runtime: 0 }),
      's',
      'skip is s',
    );
    assert.strictEqual(
      feed(reporter, context, { status: 'todo', fullName: ['Mod', 'w'], runtime: 0 }),
      't',
      'todo is t',
    );
  });

  test('failure detail is buffered, not printed inline (keeps the matrix intact)', (assert) => {
    const output = feed(new DotReporter(), makeContext(), failing());
    assert.strictEqual(output, 'F', 'no failure block interleaved with the dots');
  });

  test('wraps the matrix at 72 columns', (assert) => {
    const context = makeContext();
    const reporter = new DotReporter();
    let output = '';
    for (let i = 0; i < 73; i++) output += feed(reporter, context, passing(`t${i}`));

    const lines = output.split('\n');
    assert.strictEqual(lines.length, 2, 'wrapped onto a second line');
    assert.strictEqual(lines[0].length, 72, 'first line holds exactly 72 dots');
    assert.strictEqual(lines[1], '.', '73rd dot starts the next line');
  });

  test('summary lists failures with their detail and location', (assert) => {
    const context = makeContext();
    const reporter = new DotReporter();
    reporter.onRunStart(context, { fileCount: null, groupCount: null });
    feed(reporter, context, passing());
    feed(
      reporter,
      context,
      Object.assign(failing('divides'), {
        assertions: [
          {
            passed: false,
            todo: false,
            actual: 3,
            expected: 4,
            message: 'sum should be 4',
            stack: '    at Object.<anonymous> (http://localhost:1234/tests.js:10:5)',
          },
        ],
      }),
    );

    const output = captureStdout(() => reporter.onRunEnd(context, { durationMs: 99 }));
    assert.includes(output, '1 passing (99ms)');
    assert.includes(output, '1 failing');
    assert.includes(output, 'Failures:');
    assert.includes(output, '1) Mod | divides');
    assert.includes(output, 'sum should be 4', 'failure detail is shown at the end');
    assert.includes(output, 'at http://localhost:1234/tests.js:10:5', 'location is shown');
  });

  test('a clean run prints no failure section', (assert) => {
    const context = makeContext();
    const reporter = new DotReporter();
    reporter.onRunStart(context, { fileCount: null, groupCount: null });
    feed(reporter, context, passing());
    const output = captureStdout(() => reporter.onRunEnd(context, { durationMs: 5 }));
    assert.notIncludes(output, 'Failures:');
    assert.notIncludes(output, 'skipped', 'zero-count categories omitted');
  });

  test('onRunStart resets the column and failures for watch reruns', (assert) => {
    const context = makeContext();
    const reporter = new DotReporter();
    feed(reporter, context, failing());

    const rerun = makeContext();
    reporter.onRunStart(rerun, { fileCount: null, groupCount: null });
    feed(reporter, rerun, passing());
    const output = captureStdout(() => reporter.onRunEnd(rerun, { durationMs: 5 }));
    assert.notIncludes(output, 'Failures:', 'previous run failures are not carried over');
  });

  test('run start announces counts; the empty case says so', (assert) => {
    const context = makeContext();
    assert.includes(
      captureStdout(() => new DotReporter().onRunStart(context, { fileCount: 2, groupCount: 2 })),
      'Running 2 test files across 2 worker(s)',
    );
    assert.includes(
      captureStdout(() => new DotReporter().onRunStart(context, { fileCount: 0, groupCount: 0 })),
      'No test files found.',
    );
  });

  test('emits only status characters — no TAP header, ok lines or plan', (assert) => {
    const context = makeContext();
    const reporter = new DotReporter();
    const output =
      captureStdout(() => reporter.onRunStart(context, { fileCount: 1, groupCount: 1 })) +
      feed(reporter, context, passing()) +
      captureStdout(() => reporter.onRunEnd(context, { durationMs: 1 }));
    assert.notIncludes(output, 'TAP version 13');
    assert.notIncludes(output, 'ok 1');
    assert.notIncludes(output, '1..');
  });
});
