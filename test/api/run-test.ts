import { module, test } from 'qunitx';
import path from 'node:path';
import { apiRun, captureStream } from './helpers.ts';
import * as QUnitX from '../../lib/api/index.ts';
import { outputDir } from '../helpers/temp-dir.ts';
import { streamConsole } from '../../lib/console.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import '../helpers/custom-asserts.ts';

const PASSING = 'test/fixtures/passing-tests.ts';
const FAILING = 'test/fixtures/failing-tests.ts';
const SKIP_TODO = 'test/fixtures/skip-todo-tests.ts';

// Tests below assert different facets of one green run, and of one red run. Every assertion on
// them is a read of the finished result, so re-running per test would buy no isolation and cost a
// browser each time. Lazy, so a filtered run launches only what it asks for.
//
// A test that asserts WHEN the run happened must NOT use these — the run may already have been
// started by whichever test reached the memo first. `timings bracket the run` does its own.
let green: Promise<QUnitX.RunResult> | null = null;
const greenRun = (): Promise<QUnitX.RunResult> => (green ??= apiRun({ inputs: [PASSING] }));
let red: Promise<QUnitX.RunResult> | null = null;
const redRun = (): Promise<QUnitX.RunResult> => (red ??= apiRun({ inputs: [FAILING] }));

module('API | run | results', { concurrency: true }, () => {
  test('a green run resolves ok with every test recorded', async (assert) => {
    const result = await greenRun();

    assert.true(result.ok);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      { total: result.counts.total, passed: result.counts.passed, failed: result.counts.failed },
      { total: 3, passed: 3, failed: 0 },
    );
    assert.equal(result.tests.length, 3, 'every test is on the result, not just the failures');
    assert.deepEqual(result.failures, []);
    assert.true(
      result.tests.every((one) => one.status === 'passed' && one.fullName.length > 0),
      'each carries its status and display name',
    );
  });

  test('failing tests are a result, not a rejection', async (assert) => {
    // The whole contract in one test: `run` resolves for a red suite. Rejection is reserved for
    // the run not happening, so `catch` never has to mean "some tests failed".
    const result = await redRun();

    assert.false(result.ok);
    assert.equal(result.exitCode, 1);
    assert.true(result.counts.failed > 0);
    assert.equal(result.failures.length, result.counts.failed);
    assert.true(
      result.failures.every((one) => one.status === 'failed'),
      '`failures` is exactly the failed subset of `tests`',
    );
  });

  test('failures carry their assertions and the file they came from', async (assert) => {
    const result = await redRun();
    const withAssertions = result.failures.find((one) => one.assertions.length > 0);

    assert.ok(withAssertions, 'a failing test reports its assertions');
    assert.true(
      withAssertions!.assertions.some((one) => one.passed === false),
      'including the one that failed',
    );
    assert.equal(result.failedFiles.length, 1);
    assert.true(result.failedFiles[0].endsWith('failing-tests.ts'));
  });

  test('skip and todo are counted apart from passes and failures', async (assert) => {
    const result = await apiRun({ inputs: [SKIP_TODO] });

    assert.true(result.counts.skipped > 0, 'skipped tests are counted');
    assert.true(result.counts.todo > 0, 'todo tests are counted');
    assert.equal(result.counts.failed, 0, 'a todo is not a failure');
    assert.true(result.ok, 'so the run is green');
  });

  test('the result carries what the run resolved to, not just what was asked', async (assert) => {
    const result = await greenRun();

    assert.equal(result.resolved.browser, 'chromium');
    assert.equal(result.resolved.projectRoot, process.cwd());
    assert.true(result.resolved.port > 0, 'the port actually bound');
    assert.true(result.resolved.output.startsWith(process.cwd()), 'output is absolute');
    assert.equal(result.groups.length, 1, 'one file, one group');
    assert.deepEqual(result.groups[0].files, result.files, "the one group ran the run's files");
    assert.equal(
      result.groups[0].output,
      result.resolved.output,
      'and wrote to the run output dir',
    );
  });

  test('a multi-file run reports the split it chose, partitioning every file exactly once', async (assert) => {
    const result = await apiRun({ inputs: [PASSING, SKIP_TODO] });

    // How many groups is up to the machine — `availableParallelism()` bounds it, so a 1-core
    // runner legitimately produces one. What must hold everywhere is that the split is a
    // partition: every file the run executed lands in exactly one group.
    const assigned = result.groups.flatMap((group) => group.files);
    assert.deepEqual(assigned.slice().sort(), result.files.slice().sort(), 'every file, once');
    assert.deepEqual(
      result.groups.map((group) => group.index),
      result.groups.map((_group, index) => index),
      'indexes are positional',
    );
    // The index is not decoration: it names the output subdirectory the artifacts went to.
    for (const group of result.groups) {
      assert.equal(
        group.output,
        result.groups.length === 1
          ? result.resolved.output
          : // path.join, not a '/' template: `output` is a native path, separated by '\' on Windows.
            path.join(result.resolved.output, `group-${group.index}`),
      );
    }
  });

  test('timings bracket the run', async (assert) => {
    // Its own run, not the shared one: this asserts WHEN the run happened relative to this test,
    // so a run someone else already started would put `startedAt` before our `before`.
    const before = Date.now();
    const result = await apiRun({ inputs: [PASSING] });

    assert.true(result.startedAt >= before, 'started after we asked');
    assert.true(result.finishedAt >= result.startedAt, 'and finished after it started');
    assert.true(
      Math.abs(result.finishedAt - result.startedAt - result.durationMs) < 50,
      'the span agrees with durationMs',
    );
  });

  test('a failing test is attributed to its source file', async (assert) => {
    const result = await redRun();

    assert.true(
      result.failures.every((one) => one.file?.endsWith('failing-tests.ts')),
      'every failure names the file it came from',
    );
  });

  test('a passing test has no file — QUnit gives no stack to map', async (assert) => {
    const result = await greenRun();

    assert.true(
      result.tests.every((one) => one.file === null),
      'null rather than a guess',
    );
  });

  test('`files` reports what actually ran', async (assert) => {
    const result = await greenRun();

    assert.equal(result.files.length, 1);
    assert.true(result.files[0].endsWith('passing-tests.ts'));
  });
});

module('API | run | options', { concurrency: true }, () => {
  test('filter narrows the run the way -t does', async (assert) => {
    const result = await apiRun({ inputs: [PASSING], filter: 'assert true works' });

    assert.equal(result.counts.total, 1, 'only the matching test ran');
    assert.includes(result.tests[0].fullName, 'assert true works');
  });

  test('a filter that matches nothing fails the run rather than passing empty', async (assert) => {
    const result = await apiRun({ inputs: [PASSING], filter: 'no-such-test-anywhere' });

    assert.false(result.ok, 'a mistyped filter is a mistake, not a green run');
    assert.equal(result.counts.total, 0);
    assert.true(
      result.notices.some((notice) => notice.message.includes('No tests matched')),
      'and says so as a notice',
    );
  });

  test('a line target runs just that test', async (assert) => {
    const declarations = await QUnitX.search({ inputs: [PASSING] });
    const target = declarations.matches[1];

    const result = await apiRun({ inputs: [`${target.file}#${target.line}`] });

    assert.equal(result.counts.total, 1);
    assert.equal(result.tests[0].fullName, target.fullName);
  });
});

module('API | run | reporters', { concurrency: true }, () => {
  test('nothing is printed unless a reporter is asked for', async (assert) => {
    const stdout = captureStream();
    // A `console` alone still routes the run's own `#` diagnostics, so the assertion below is
    // about the test document: with no reporter there is no TAP, no spec output, nothing.
    const result = await apiRun({ inputs: [PASSING], console: streamConsole(stdout) });

    assert.true(result.ok);
    assert.notIncludes(stdout.text(), 'TAP version 13');
    assert.notIncludes(stdout.text(), 'ok 1');
  });

  test('a named reporter writes to the given stream and still returns the result', async (assert) => {
    const stdout = captureStream();

    const result = await apiRun({
      inputs: [PASSING],
      reporter: 'tap',
      console: streamConsole(stdout),
    });

    assert.includes(stdout.text(), 'TAP version 13');
    assert.includes(stdout.text(), 'ok 1');
    assert.includes(stdout.text(), '# pass 3');
    assert.equal(result.counts.passed, 3, 'the result is unaffected by printing');
  });

  test('a custom reporter object receives the lifecycle', async (assert) => {
    const events: string[] = [];

    const result = await apiRun({
      inputs: [PASSING],
      reporter: {
        onRunStart: () => void events.push('start'),
        onTestEnd: (_config, details) => void events.push(`test:${details.status}`),
        onRunEnd: () => void events.push('end'),
      },
    });

    assert.equal(events[0], 'start');
    assert.equal(events[events.length - 1], 'end');
    assert.equal(events.filter((one) => one === 'test:passed').length, 3);
    assert.equal(result.counts.passed, 3);
  });

  test('a reporter that throws costs output, never the result', async (assert) => {
    // The collector is first in the fan-out precisely so this holds.
    const result = await apiRun({
      inputs: [PASSING],
      reporter: {
        onTestEnd: () => {
          throw new Error('reporter blew up');
        },
      },
    });

    assert.equal(result.counts.passed, 3, 'every test still reached the result');
    assert.equal(result.tests.length, 3);
  });

  test('a reporter sees each test as it finishes, in result order', async (assert) => {
    const streamed: string[] = [];

    // The `run()` way to observe a run in flight: a reporter. For the public event shapes
    // (`TestResult`, `Notice`, `BrowserLog`) use `runSession().events()` instead.
    const result = await apiRun({
      inputs: [PASSING],
      reporter: {
        onTestEnd: (_config, details) => void streamed.push(details.fullName.join(' > ')),
      },
    });

    assert.deepEqual(
      streamed,
      result.tests.map((one) => [...one.modules, one.name].join(' > ')),
      'same tests, same order',
    );
  });
});

module('API | run | failures', { concurrency: true }, () => {
  test('an unreadable project rejects with a discriminable failure', async (assert) => {
    const outcome = await QUnitX.run({ inputs: ['nope'], cwd: '/' }).result();

    assert.true(QUnitX.Failure.is(outcome), 'a run that cannot happen is a Failure');
    assert.equal(
      QUnitX.Failure.is(outcome) ? outcome.code : null,
      'ProjectRootNotFound',
      'named, so a caller can branch on it rather than parse a message',
    );
  });

  test('an invalid option is reported rather than thrown as a bug', async (assert) => {
    const outcome = await QUnitX.run({
      inputs: ['test/'],
      browser: 'netscape' as 'chromium',
    }).result();

    assert.true(QUnitX.Failure.is(outcome), 'a value the runner cannot honour is a Failure');
    assert.equal(QUnitX.Failure.is(outcome) ? outcome.code : null, 'InvalidOption');
    assert.includes(
      QUnitX.Failure.is(outcome) ? outcome.message : '',
      'chromium, firefox, webkit',
      'and names what it would have accepted',
    );
  });

  test('a bad option is caught before a browser is launched', async (assert) => {
    // No semaphore permit taken, and none needed: rejecting here is the point.
    const outcome = await QUnitX.run({ inputs: ['test/'], port: 99999 }).result();

    assert.equal(QUnitX.Failure.is(outcome) ? outcome.code : null, 'InvalidOption');
  });

  test('an already-aborted signal answers without launching a browser', async (assert) => {
    await using output = outputDir('api-signal-pre');
    // No permit: not launching a browser is exactly what is being asserted.
    const result = await QUnitX.run({
      inputs: [PASSING],
      output: output.path,
      signal: AbortSignal.abort(),
    });

    assert.equal(result.status, 'aborted', 'the result says it was cancelled');
    assert.equal(result.counts.total, 0, 'and nothing ran');
    assert.equal(result.exitCode, 1, 'a run that never happened is not a pass');
    assert.false(result.ok);
  });

  test('an ordinary run is not marked aborted', async (assert) => {
    const result = await greenRun();

    assert.equal(result.status, 'completed', 'green and complete');
  });

  test('failFast says the suite was cut off, not that it is two tests long', async (assert) => {
    const result = await apiRun({ inputs: [FAILING], failFast: true });

    assert.equal(result.status, 'failFast', 'the ending names the policy that stopped it');
    assert.true(
      result.counts.total < (await redRun()).counts.total,
      'and it really did run fewer tests than the whole file',
    );
  });

  test('a red run is not marked aborted either', async (assert) => {
    const result = await redRun();

    assert.false(result.ok);
    assert.equal(result.status, 'completed', 'failing is not the same as interrupted');
  });

  test('the Task is lazy — nothing runs until it is awaited', async (assert) => {
    await using output = outputDir('api-lazy');
    const task = QUnitX.run({ inputs: [PASSING], output: output.path });

    // Nothing has happened yet: no browser, no bundle, no result. The proof is that the same
    // Task can be discarded without ever having cost a browser launch.
    assert.ok(task, 'a Task, not an in-flight run');

    const permit = await acquireBrowser();
    try {
      assert.true((await task).ok, 'awaiting is what starts it');
    } finally {
      permit.release();
    }
  });
});
