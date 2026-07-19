import { module, test } from 'qunitx';
import { DotReporter } from '../../lib/reporter/dot.ts';
import { updateCounter } from '../../lib/reporter/types.ts';
import { newRunState } from '../../lib/setup/run-state.ts';
import type { TestDetails } from '../../lib/reporter/types.ts';
import type { Config } from '../../lib/types.ts';
import '../helpers/custom-asserts.ts';
import { captureStdout } from '../helpers/capture-stdout.ts';

// Colors are disabled in a non-TTY (see lib/utils/color.ts), so these match plain characters.
const makeConfig = (): Config =>
  ({
    projectRoot: '/proj',
    reporter: 'dot',
    state: newRunState(),
  }) as unknown as Config;

const feed = (reporter: DotReporter, config: Config, details: TestDetails): string =>
  captureStdout(() => {
    updateCounter(config.state.results.counter, details);
    reporter.onTestEnd(config, details);
  });

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

module('reporters | DotReporter', { concurrency: true }, () => {
  test('emits one character per test, by status', (assert) => {
    const config = makeConfig();
    const reporter = new DotReporter();
    assert.strictEqual(feed(reporter, config, passing()), '.', 'pass is a dot');
    assert.strictEqual(feed(reporter, config, failing()), 'F', 'fail is F');
    assert.strictEqual(
      feed(reporter, config, { status: 'skipped', fullName: ['Mod', 's'], runtime: 0 }),
      's',
      'skip is s',
    );
    assert.strictEqual(
      feed(reporter, config, { status: 'todo', fullName: ['Mod', 'w'], runtime: 0 }),
      't',
      'todo is t',
    );
  });

  test('failure detail is buffered, not printed inline (keeps the matrix intact)', (assert) => {
    const output = feed(new DotReporter(), makeConfig(), failing());
    assert.strictEqual(output, 'F', 'no failure block interleaved with the dots');
  });

  test('wraps the matrix at 72 columns', (assert) => {
    const config = makeConfig();
    const reporter = new DotReporter();
    let output = '';
    for (let i = 0; i < 73; i++) output += feed(reporter, config, passing(`t${i}`));

    const lines = output.split('\n');
    assert.strictEqual(lines.length, 2, 'wrapped onto a second line');
    assert.strictEqual(lines[0].length, 72, 'first line holds exactly 72 dots');
    assert.strictEqual(lines[1], '.', '73rd dot starts the next line');
  });

  test('summary lists failures with their detail and location', (assert) => {
    const config = makeConfig();
    const reporter = new DotReporter();
    reporter.onRunStart(config, { fileCount: null, groupCount: null });
    feed(reporter, config, passing());
    feed(
      reporter,
      config,
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

    const output = captureStdout(() => reporter.onRunEnd(config, { durationMs: 99 }));
    assert.includes(output, '1 passing (99ms)');
    assert.includes(output, '1 failing');
    assert.includes(output, 'Failures:');
    assert.includes(output, '1) Mod | divides');
    assert.includes(output, 'sum should be 4', 'failure detail is shown at the end');
    assert.includes(output, 'at http://localhost:1234/tests.js:10:5', 'location is shown');
  });

  test('a clean run prints no failure section', (assert) => {
    const config = makeConfig();
    const reporter = new DotReporter();
    reporter.onRunStart(config, { fileCount: null, groupCount: null });
    feed(reporter, config, passing());
    const output = captureStdout(() => reporter.onRunEnd(config, { durationMs: 5 }));
    assert.notIncludes(output, 'Failures:');
    assert.notIncludes(output, 'skipped', 'zero-count categories omitted');
  });

  test('onRunStart resets the column and failures for watch reruns', (assert) => {
    const config = makeConfig();
    const reporter = new DotReporter();
    feed(reporter, config, failing());

    const rerun = makeConfig();
    reporter.onRunStart(rerun, { fileCount: null, groupCount: null });
    feed(reporter, rerun, passing());
    const output = captureStdout(() => reporter.onRunEnd(rerun, { durationMs: 5 }));
    assert.notIncludes(output, 'Failures:', 'previous run failures are not carried over');
  });

  test('run start announces counts; the empty case says so', (assert) => {
    const config = makeConfig();
    assert.includes(
      captureStdout(() => new DotReporter().onRunStart(config, { fileCount: 2, groupCount: 2 })),
      'Running 2 test files across 2 worker(s)',
    );
    assert.includes(
      captureStdout(() => new DotReporter().onRunStart(config, { fileCount: 0, groupCount: 0 })),
      'No test files found.',
    );
  });

  test('never emits TAP syntax', (assert) => {
    const config = makeConfig();
    const reporter = new DotReporter();
    const output =
      captureStdout(() => reporter.onRunStart(config, { fileCount: 1, groupCount: 1 })) +
      feed(reporter, config, passing()) +
      captureStdout(() => reporter.onRunEnd(config, { durationMs: 1 }));
    assert.notIncludes(output, 'TAP version 13');
    assert.notIncludes(output, 'ok 1');
    assert.notIncludes(output, '1..');
  });
});
