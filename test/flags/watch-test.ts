import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';
import { shellWatch } from '../helpers/shell.ts';

module('--watch flag tests', { concurrency: true }, () => {
  test('--watch runs tests, starts the server, and prints watching info', async (assert) => {
    const stdout = await shellWatch('node cli.ts test/fixtures/passing-tests.ts --watch', {
      until: (buf) => buf.includes('Press "qq"'),
    });

    assert.passingTestCaseFor(stdout, { moduleName: '{{moduleName}}' });
    assert.tapResult(stdout, { testCount: 3 });
    assert.includes(stdout, 'Watching files...');
    assert.includes(stdout, 'http://localhost:');
    assert.includes(stdout, 'Press "qq"');
    assert.includes(stdout, '"qa"');
    assert.includes(stdout, '"qf"');
    assert.includes(stdout, '"ql"');
  });

  // Regression: a glob input (`test/**/!(x).ts`) reaches the watcher as a raw glob string, which
  // is not a real filesystem path, so fs.watch threw ENOENT on it and crashed the whole run —
  // even though the initial (non-watch) build had resolved the glob fine. The fix collapses each
  // lookup path to its deepest existing directory before watching.
  test('--watch accepts a glob input without crashing on fs.watch ENOENT', async (assert) => {
    const stdout = await shellWatch("node cli.ts 'test/fixtures/**/!(plugin-tests).ts' --watch", {
      until: (buf) => buf.includes('Press "qq"'),
    });

    assert.includes(stdout, 'Watching files...', 'the watcher started');
    assert.notIncludes(stdout, 'ENOENT');
    assert.notIncludes(stdout, "watch '");
  });

  // Regression test: shellWatch was releasing the semaphore permit immediately after sending
  // SIGTERM, before the CLI process had fully exited. This allowed the next test to acquire
  // the permit and launch a new Chrome while the previous Chrome was still shutting down —
  // momentarily exceeding the concurrency cap.
  //
  // The exact contract: shellWatch must await `child.on('exit')` before releasing the permit.
  // Node sets `child.exitCode`/`child.signalCode` only when that event fires, so checking
  // them after shellWatch returns is the most direct possible test of the contract. No
  // kernel-state proxies (port-free probes flaked under load due to lingering TCP cleanup),
  // no syscalls, no platform variance — exactly what shellWatch's internal terminateChild
  // is supposed to be waiting on.
  test('shellWatch releases the semaphore permit only after the child process has fully exited', async (assert) => {
    let captured: ChildProcessWithoutNullStreams | null = null;

    await shellWatch('node cli.ts test/fixtures/passing-tests.ts --watch', {
      until: (buf) => buf.includes('Press "qq"'),
      onSpawn: (child) => {
        captured = child;
      },
    });

    assert.ok(captured !== null, 'shellWatch exposed the spawned child');
    const exited = captured!.exitCode !== null || captured!.signalCode !== null;
    assert.true(
      exited,
      `shellWatch's child emitted 'exit' before permit release (exitCode=${captured!.exitCode}, signalCode=${captured!.signalCode})`,
    );
  });
});
