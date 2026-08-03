import { module, test } from 'qunitx';
import { daemon } from '../../lib/api/index.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import { outputDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';

const PASSING = 'test/fixtures/passing-tests.ts';
const FAILING = 'test/fixtures/failing-tests.ts';

// One daemon serves one project directory, and this suite starts and stops the real thing — so
// its tests share that single daemon and must not interleave with each other.
//
// Skipped on Windows for the same reason test/commands/daemon-test.ts is: the daemon spawn path
// there is covered by the CLI suite, and doubling it doubles the flakiest lane's cost.
const SKIP = process.platform === 'win32';

module('API | daemon', { concurrency: false, skip: SKIP }, () => {
  test('status reports no daemon before one is started', async (assert) => {
    await daemon.stop();

    assert.deepEqual(await daemon.status(), { running: false });
  });

  test('start brings one up, status describes it, stop takes it down', async (assert) => {
    const permit = await acquireBrowser();
    try {
      assert.true(await daemon.start(), 'started');

      const running = await daemon.status();
      assert.true(running.running);
      if (running.running) {
        assert.true(running.pid > 0, 'with a pid');
        assert.equal(running.cwd, process.cwd(), 'serving this project');
        assert.includes(running.socketPath, 'qunitx');
      }

      assert.true(await daemon.stop(), 'stopped');
      assert.deepEqual(await daemon.status(), { running: false });
    } finally {
      permit.release();
    }
  });

  test('start is idempotent', async (assert) => {
    const permit = await acquireBrowser();
    try {
      assert.true(await daemon.start());
      assert.true(await daemon.start(), 'a second call is a liveness probe, not a second daemon');
    } finally {
      await daemon.stop();
      permit.release();
    }
  });

  test('stop on nothing reports false rather than failing', async (assert) => {
    await daemon.stop();

    assert.false(await daemon.stop(), 'nothing was running');
  });

  test('run returns the same structured result a local run does', async (assert) => {
    await using output = outputDir('api-daemon-run');
    const permit = await acquireBrowser();
    try {
      const result = await daemon.run({ inputs: [PASSING], output: output.path });

      assert.true(result.ok);
      assert.equal(result.counts.total, 3);
      assert.equal(result.tests.length, 3, 'the per-test detail survives the socket');
      assert.true(result.files[0].endsWith('passing-tests.ts'));
    } finally {
      await daemon.stop();
      permit.release();
    }
  });

  test('a failing run through the daemon is a result, not a rejection', async (assert) => {
    await using output = outputDir('api-daemon-fail');
    const permit = await acquireBrowser();
    try {
      const result = await daemon.run({ inputs: [FAILING], output: output.path });

      assert.false(result.ok);
      assert.true(result.failures.length > 0);
      assert.true(result.failedFiles[0].endsWith('failing-tests.ts'));
    } finally {
      await daemon.stop();
      permit.release();
    }
  });

  test('two consecutive runs both answer, the second on a warm browser', async (assert) => {
    await using output = outputDir('api-daemon-warm');
    const permit = await acquireBrowser();
    try {
      const first = await daemon.run({ inputs: [PASSING], output: output.path });
      const second = await daemon.run({ inputs: [PASSING], output: output.path });

      assert.equal(first.counts.total, 3);
      assert.equal(second.counts.total, 3, 'reuse does not leak state between runs');
      assert.deepEqual(
        second.tests.map((one) => one.fullName),
        first.tests.map((one) => one.fullName),
      );
    } finally {
      await daemon.stop();
      permit.release();
    }
  });

  test('a named reporter streams the daemon text into the given stdout', async (assert) => {
    await using output = outputDir('api-daemon-tap');
    const chunks: string[] = [];
    const permit = await acquireBrowser();
    try {
      const result = await daemon.run({
        inputs: [PASSING],
        output: output.path,
        reporter: 'tap',
        stdout: { write: (text) => void chunks.push(text) },
      });

      assert.includes(chunks.join(''), 'TAP version 13', 'the daemon-side output arrives here');
      assert.equal(result.counts.passed, 3, 'and the structured result comes back too');
    } finally {
      await daemon.stop();
      permit.release();
    }
  });
});
