import { module, test } from 'qunitx';
import { GithubReporter, annotation } from '../../lib/reporter/github.ts';
import { updateCounter } from '../../lib/reporter/types.ts';
import * as RunState from '../../lib/setup/run-state.ts';
import type { FailureInfo } from '../../lib/reporter/failure.ts';
import type { TestDetails } from '../../lib/reporter/types.ts';
import type { Config } from '../../lib/types.ts';
import '../helpers/custom-asserts.ts';
import { captureStdout } from '../helpers/capture-stdout.ts';

const makeConfig = (): Config =>
  ({
    projectRoot: '/proj',
    reporter: 'github',
    state: RunState.create(),
  }) as unknown as Config;

const failure = (overrides: Partial<FailureInfo> = {}): FailureInfo => ({
  index: 1,
  message: 'boom',
  actual: 3,
  expected: 4,
  stack: null,
  at: 'src/app.ts:12:5',
  source: null,
  ...overrides,
});

module('reporters | github annotation', { concurrency: true }, () => {
  test('emits ::error with file, line, col and title', (assert) => {
    const output = annotation('Math | adds', failure());
    assert.true(
      output.startsWith('::error file=src/app.ts,line=12,col=5,title=Math | adds::'),
      `unexpected annotation: ${output}`,
    );
    assert.includes(output, 'boom');
  });

  test('includes expected/actual in the message', (assert) => {
    const output = annotation('t', failure());
    assert.includes(output, 'expected: 4');
    assert.includes(output, 'actual:   3');
  });

  test('newlines are escaped so the command is not truncated', (assert) => {
    const output = annotation('t', failure({ message: 'line one\nline two' }));
    assert.includes(output, 'line one%0Aline two', 'newline becomes %0A');
    assert.strictEqual(output.split('\n').length, 1, 'annotation stays on a single line');
  });

  test('percent and carriage return are escaped in the message', (assert) => {
    const output = annotation(
      't',
      failure({ message: '100% done\rx', actual: undefined, expected: undefined }),
    );
    assert.includes(output, '100%25 done%0Dx');
  });

  test('property values escape the command delimiters : and ,', (assert) => {
    // A URL location is the realistic case: it contains colons that would otherwise be read
    // as property separators.
    const output = annotation('a, b: c', failure({ at: null }));
    assert.includes(output, 'title=a%2C b%3A c', 'comma and colon escaped in the title');
  });

  test('omits location properties when the failure has no resolvable location', (assert) => {
    const output = annotation('t', failure({ at: null }));
    assert.notIncludes(output, 'file=');
    assert.notIncludes(output, 'line=');
    assert.true(output.startsWith('::error title=t::'), `unexpected: ${output}`);
  });

  test('falls back to an assertion label when there is no message', (assert) => {
    const output = annotation('t', failure({ message: null, index: 3 }));
    assert.includes(output, 'Assertion #3 failed');
  });

  test('omits the values block when neither actual nor expected is present', (assert) => {
    const output = annotation('t', failure({ actual: undefined, expected: undefined }));
    assert.notIncludes(output, 'expected:');
    assert.notIncludes(output, 'actual:');
  });
});

module('reporters | GithubReporter', { concurrency: true }, () => {
  const feed = (reporter: GithubReporter, config: Config, details: TestDetails): string =>
    captureStdout(() => {
      updateCounter(config.state.results.counter, details);
      reporter.onTestEnd(config, details);
    });

  test('passing tests render like spec and emit no annotation', (assert) => {
    const output = feed(new GithubReporter(), makeConfig(), {
      status: 'passed',
      fullName: ['Math', 'adds'],
      runtime: 2,
      assertions: [],
    });
    assert.includes(output, '✔ adds (2ms)', 'spec output is preserved');
    assert.notIncludes(output, '::error', 'no annotation for a passing test');
  });

  test('a failing test emits spec output plus one annotation per failing assertion', (assert) => {
    const output = feed(new GithubReporter(), makeConfig(), {
      status: 'failed',
      fullName: ['Math', 'adds'],
      runtime: 2,
      assertions: [
        {
          passed: false,
          todo: false,
          actual: 1,
          expected: 2,
          message: 'first',
          stack: '    at Object.<anonymous> (http://localhost:1234/tests.js:5:1)',
        },
        { passed: true, todo: false, actual: 1, expected: 1 },
        { passed: false, todo: false, actual: 3, expected: 4, message: 'second' },
      ],
    });
    assert.includes(output, '✖ adds (2ms)', 'spec line still printed');
    assert.strictEqual(
      (output.match(/::error /g) ?? []).length,
      2,
      'one annotation per failing assertion (passing one excluded)',
    );
    assert.includes(output, 'title=Math | adds');
  });

  test('skipped tests emit no annotation', (assert) => {
    const output = feed(new GithubReporter(), makeConfig(), {
      status: 'skipped',
      fullName: ['Math', 'later'],
      runtime: 0,
    });
    assert.notIncludes(output, '::error');
  });

  test('delegates run start and run end to the spec renderer', (assert) => {
    const config = makeConfig();
    const reporter = new GithubReporter();
    assert.includes(
      captureStdout(() => reporter.onRunStart(config, { fileCount: 1, groupCount: 1 })),
      'Running 1 test file across 1 worker(s)',
    );
    feed(reporter, config, { status: 'passed', fullName: ['M', 't'], runtime: 1, assertions: [] });
    assert.includes(
      captureStdout(() => reporter.onRunEnd(config, { durationMs: 7 })),
      '1 passing (7ms)',
    );
  });
});
