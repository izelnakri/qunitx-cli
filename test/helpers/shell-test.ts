import path from 'node:path';
import { module, test } from 'qunitx';
import { spawnCapture } from './shell.ts';

// Use a fixture script rather than `node -e` so the test command line has no whitespace
// inside any arg — shell.ts's parseCommand splits on whitespace, which is correct for the
// qunitx CLI invocations the helper actually runs but would mangle inline scripts. The
// fields asserted below are exactly the diagnostic surface custom-asserts.ts forwards into
// failure messages, so a regression here would silently re-flatten Windows flake reports
// back to "stdout truncated, ¯\_(ツ)_/¯".
// Use the literal token `node` — parseCommand swaps it for process.execPath internally.
// `${process.execPath} ${FIXTURE}` would shell-fragment on Windows because
// `C:\\Program Files\\nodejs\\node.exe` contains a space.
const FIXTURE = path.join(process.cwd(), 'test/helpers/spawn-capture-fixture.js');
const cmd = (mode: string) => `node ${FIXTURE} ${mode}`;

module('Helpers | spawnCapture | success path', { concurrency: true }, () => {
  test('captures stdout, stderr, exit code 0, null signal, and a positive duration', async (assert) => {
    const result = await spawnCapture(cmd('success'));
    assert.equal(result.stdout, 'hello');
    assert.equal(result.stderr, 'warn');
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.signal, null);
    assert.ok(result.duration > 0, `duration is positive (got ${result.duration})`);
  });

  test('records stdout chunks with arrival timestamps ordered by time', async (assert) => {
    // Two writes separated by 50 ms — the captured chunks must preserve order with strictly
    // non-decreasing timestamps so the "last chunk at X ms" line in failure output is meaningful.
    const result = await spawnCapture(cmd('two-chunks'));
    assert.equal(result.stdout, 'ab');
    assert.ok(result.stdoutChunks.length >= 1, 'at least one stdout chunk recorded');
    for (let i = 1; i < result.stdoutChunks.length; i++) {
      assert.ok(
        result.stdoutChunks[i].time >= result.stdoutChunks[i - 1].time,
        'chunk timestamps are monotonically non-decreasing',
      );
    }
  });
});

module('Helpers | spawnCapture | failure paths', { concurrency: true }, () => {
  test('rejects with a CapturedError carrying the full diagnostic surface on non-zero exit', async (assert) => {
    await assert.rejects(
      spawnCapture(cmd('fail')),
      (err: Error & { code: number; signal: null; stdout: string; duration: number }) => {
        assert.equal(err.stdout, 'partial', 'partial stdout preserved on rejection');
        assert.strictEqual(err.code, 7);
        assert.strictEqual(err.signal, null);
        assert.ok(err.duration > 0, 'duration recorded even on failure');
        return true;
      },
    );
  });

  test('rejects with a CapturedError reporting the terminating signal when timed out', async (assert) => {
    // Long sleep + short timeout — spawnCapture sends SIGTERM, the child exits via signal,
    // and the rejection's `signal` field is what tells us "this was a timeout, not a crash."
    // exec() would have hidden this distinction on Windows entirely.
    await assert.rejects(
      spawnCapture(cmd('sleep'), { timeout: 100 }),
      (err: Error & { code: number | null; signal: NodeJS.Signals | null; duration: number }) => {
        assert.ok(err.signal !== null || err.code !== 0, 'killed by signal or non-zero exit');
        assert.ok(err.duration < 4_000, `terminated quickly (${err.duration} ms)`);
        return true;
      },
    );
  });
});
