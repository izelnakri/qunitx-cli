import { module, test } from 'qunitx';
import { SpecReporter } from '../../lib/reporters/spec.ts';
import type { TestDetails } from '../../lib/reporters/types.ts';
import '../helpers/custom-asserts.ts';
import { captureStdout } from '../helpers/capture-stdout.ts';
import { feed, makeContext } from '../helpers/reporter-context.ts';

// Colors are disabled in a non-TTY (see lib/utils/color.ts), so these assertions match plain text.
// Drives the reporter the way Reporters.testEnd does: counter first, then the reporter.
const passing = (name: string, moduleName = 'Math'): TestDetails => ({
  status: 'passed',
  fullName: [moduleName, name],
  runtime: 3,
  assertions: [],
});

module('Reporters | SpecReporter', { concurrency: true }, () => {
  test('prints a module header once, then indents its tests under it', (assert) => {
    const context = makeContext();
    const reporter = new SpecReporter();
    const first = feed(reporter, context, passing('adds'));
    const second = feed(reporter, context, passing('subtracts'));

    assert.includes(first, 'Math\n', 'module header printed for the first test');
    assert.includes(first, '  ✔ adds (3ms)\n', 'test indented under the module');
    assert.notIncludes(second, 'Math\n', 'header not repeated for the same module');
    assert.includes(second, '  ✔ subtracts (3ms)\n');
  });

  test('prints a new header when the module changes', (assert) => {
    const context = makeContext();
    const reporter = new SpecReporter();
    feed(reporter, context, passing('adds', 'Math'));
    const output = feed(reporter, context, passing('trims', 'Strings'));
    assert.includes(output, 'Strings\n', 'new module gets its own header');
  });

  test('nested modules render as a > b, root-level tests as (root)', (assert) => {
    const context = makeContext();
    assert.includes(
      feed(new SpecReporter(), context, {
        status: 'passed',
        fullName: ['outer', 'inner', 'test'],
        runtime: 1,
        assertions: [],
      }),
      'outer > inner\n',
    );
    assert.includes(
      feed(new SpecReporter(), context, {
        status: 'passed',
        fullName: ['top level'],
        runtime: 1,
        assertions: [],
      }),
      '(root)\n',
    );
  });

  test('failed tests show the message, values, and location inline', (assert) => {
    const output = feed(new SpecReporter(), makeContext(), {
      status: 'failed',
      fullName: ['Math', 'adds'],
      runtime: 4,
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
    });
    assert.includes(output, '  ✖ adds (4ms)\n', 'failed mark');
    assert.includes(output, 'sum should be 4', 'assertion message');
    assert.includes(output, 'expected: 4', 'expected value');
    assert.includes(output, 'actual:   3', 'actual value');
    assert.includes(output, 'at http://localhost:1234/tests.js:10:5', 'location');
  });

  test('skipped and todo tests use distinct marks and no duration', (assert) => {
    const context = makeContext();
    const skipped = feed(new SpecReporter(), context, {
      status: 'skipped',
      fullName: ['Math', 'later'],
      runtime: 0,
      assertions: [],
    });
    const todo = feed(new SpecReporter(), context, {
      status: 'todo',
      fullName: ['Math', 'wip'],
      runtime: 0,
      assertions: [],
    });
    assert.includes(skipped, '  - later\n', 'skipped mark, no duration');
    assert.includes(todo, '  ◌ wip\n', 'todo mark, no duration');
  });

  test('summary counts only non-zero categories, and lists failures', (assert) => {
    const context = makeContext();
    const reporter = new SpecReporter();
    reporter.onRunStart(context, { fileCount: null, groupCount: null });
    feed(reporter, context, passing('adds'));
    feed(reporter, context, {
      status: 'failed',
      fullName: ['Math', 'divides'],
      runtime: 1,
      assertions: [{ passed: false, todo: false, actual: 1, expected: 2, message: 'nope' }],
    });

    const output = captureStdout(() => reporter.onRunEnd(context, { durationMs: 120 }));
    assert.includes(output, '1 passing (120ms)');
    assert.includes(output, '1 failing');
    assert.notIncludes(output, 'skipped', 'zero-count categories are omitted');
    assert.notIncludes(output, 'todo', 'zero-count categories are omitted');
    assert.includes(output, 'Failures:', 'failure recap is printed');
    assert.includes(output, '1) Math | divides', 'recap names the failing test');
  });

  test('a clean run prints no failure recap', (assert) => {
    const context = makeContext();
    const reporter = new SpecReporter();
    reporter.onRunStart(context, { fileCount: null, groupCount: null });
    feed(reporter, context, passing('adds'));
    const output = captureStdout(() => reporter.onRunEnd(context, { durationMs: 10 }));
    assert.notIncludes(output, 'Failures:');
  });

  test('onRunStart resets state so watch reruns do not accumulate', (assert) => {
    const context = makeContext();
    const reporter = new SpecReporter();
    feed(reporter, context, {
      status: 'failed',
      fullName: ['Math', 'divides'],
      runtime: 1,
      assertions: [{ passed: false, todo: false, actual: 1, expected: 2, message: 'nope' }],
    });

    // Second run: fresh counters + fresh reporter state.
    const rerun = makeContext();
    reporter.onRunStart(rerun, { fileCount: null, groupCount: null });
    const rerunOutput = feed(reporter, rerun, passing('adds'));
    assert.includes(rerunOutput, 'Math\n', 'module header reprinted after the reset');

    const output = captureStdout(() => reporter.onRunEnd(rerun, { durationMs: 5 }));
    assert.notIncludes(output, 'Failures:', 'previous run failures are not carried over');
  });

  test('run start announces the file/worker counts, and the empty case', (assert) => {
    const context = makeContext();
    assert.includes(
      captureStdout(() => new SpecReporter().onRunStart(context, { fileCount: 3, groupCount: 2 })),
      'Running 3 test files across 2 worker(s)',
    );
    assert.includes(
      captureStdout(() => new SpecReporter().onRunStart(context, { fileCount: 1, groupCount: 1 })),
      'Running 1 test file across 1 worker(s)',
      'singular file',
    );
    assert.includes(
      captureStdout(() => new SpecReporter().onRunStart(context, { fileCount: 0, groupCount: 0 })),
      'No test files found.',
    );
  });

  test('emits only the indented spec tree — no TAP header, ok lines or plan', (assert) => {
    const context = makeContext();
    const reporter = new SpecReporter();
    const output =
      captureStdout(() => reporter.onRunStart(context, { fileCount: 1, groupCount: 1 })) +
      feed(reporter, context, passing('adds')) +
      captureStdout(() => reporter.onRunEnd(context, { durationMs: 1 }));
    assert.notIncludes(output, 'TAP version 13');
    assert.notIncludes(output, 'ok 1');
    assert.notIncludes(output, '1..');
  });
});
