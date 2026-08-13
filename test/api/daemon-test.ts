import { module, test } from 'qunitx';
import { Daemon } from '../../lib/api/index.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import { outputDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';
import { streamConsole } from '../../lib/console.ts';

const PASSING = 'test/fixtures/passing-tests.ts';
const FAILING = 'test/fixtures/failing-tests.ts';

// One daemon serves one project directory, and this suite starts and stops the real thing — so
// its tests share that single daemon and must not interleave with each other.
//
// Skipped on Windows for the same reason test/commands/daemon-test.ts is: the daemon spawn path
// there is covered by the CLI suite, and doubling it doubles the flakiest lane's cost.
const SKIP = process.platform === 'win32';

module('API | Daemon', { concurrency: false, skip: SKIP }, () => {
  test('status reports no daemon before one is started', async (assert) => {
    await Daemon.stop();

    assert.deepEqual(await Daemon.status(), { running: false });
  });

  test('start brings one up, status describes it, stop takes it down', async (assert) => {
    const permit = await acquireBrowser();
    try {
      assert.true(await Daemon.start(), 'started');

      const running = await Daemon.status();
      assert.true(running.running);
      if (running.running) {
        assert.true(running.pid > 0, 'with a pid');
        assert.equal(running.cwd, process.cwd(), 'serving this project');
        assert.includes(running.socketPath, 'qunitx');
      }

      assert.true(await Daemon.stop(), 'stopped');
      assert.deepEqual(await Daemon.status(), { running: false });
    } finally {
      permit.release();
    }
  });

  test('start is idempotent', async (assert) => {
    const permit = await acquireBrowser();
    try {
      assert.true(await Daemon.start());
      assert.true(await Daemon.start(), 'a second call is a liveness probe, not a second daemon');
    } finally {
      await Daemon.stop();
      permit.release();
    }
  });

  test('stop on nothing reports false rather than failing', async (assert) => {
    await Daemon.stop();

    assert.false(await Daemon.stop(), 'nothing was running');
  });

  // From here on the tests SHARE one daemon: the first spawns it, the rest reuse it, and only
  // the last stops it. Spawning per test paid up to SPAWN_TIMEOUT_MS of exposure each — four
  // spawns for four assertions — and under CI contention that is exactly what went red. Sharing
  // is also the situation these tests are about: a daemon serving several runs in a row.

  test('run returns the same structured result a local run does', async (assert) => {
    await using output = outputDir('api-daemon-run');
    const permit = await acquireBrowser();
    try {
      // Spawned explicitly rather than left to `run`'s auto-spawn, so a spawn that never became
      // reachable is reported as such instead of surfacing as `DaemonUnreachable` mid-assertion.
      assert.true(await Daemon.start(), 'the shared daemon came up');

      const result = await Daemon.run({ inputs: [PASSING], output: output.path });

      assert.true(result.ok);
      assert.equal(result.counts.total, 3);
      assert.equal(result.tests.length, 3, 'the per-test detail survives the socket');
      assert.true(result.files[0].endsWith('passing-tests.ts'));
    } finally {
      permit.release();
    }
  });

  test('a failing run through the daemon is a result, not a rejection', async (assert) => {
    await using output = outputDir('api-daemon-fail');
    const permit = await acquireBrowser();
    try {
      const result = await Daemon.run({ inputs: [FAILING], output: output.path });

      assert.false(result.ok);
      assert.true(result.failures.length > 0);
      assert.true(result.failedFiles[0].endsWith('failing-tests.ts'));
    } finally {
      permit.release();
    }
  });

  test('two consecutive runs both answer, the second on a warm browser', async (assert) => {
    await using output = outputDir('api-daemon-warm');
    const permit = await acquireBrowser();
    try {
      const first = await Daemon.run({ inputs: [PASSING], output: output.path });
      const second = await Daemon.run({ inputs: [PASSING], output: output.path });

      assert.equal(first.counts.total, 3);
      assert.equal(second.counts.total, 3, 'reuse does not leak state between runs');
      assert.deepEqual(
        second.tests.map((one) => one.fullName),
        first.tests.map((one) => one.fullName),
      );
    } finally {
      permit.release();
    }
  });

  test('a named reporter streams the daemon text into the given console', async (assert) => {
    await using output = outputDir('api-daemon-tap');
    const chunks: string[] = [];
    const permit = await acquireBrowser();
    try {
      const result = await Daemon.run({
        inputs: [PASSING],
        output: output.path,
        reporter: 'tap',
        console: streamConsole({ write: (text: string) => void chunks.push(text) }),
      });

      assert.includes(chunks.join(''), 'TAP version 13', 'the daemon-side output arrives here');
      assert.equal(result.counts.passed, 3, 'and the structured result comes back too');
    } finally {
      // The last of the shared-daemon tests owns the teardown.
      await Daemon.stop();
      permit.release();
    }
  });
});
