import { module, test } from 'qunitx';
import net from 'node:net';
import '../helpers/custom-asserts.ts';
import { shellWatch } from '../helpers/shell.ts';

module('--watch flag tests', { concurrency: true }, () => {
  test('--watch runs tests, starts the server, and prints watching info', async (assert) => {
    const stdout = await shellWatch('node cli.ts test/helpers/passing-tests.ts --watch', {
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

  // Regression test: shellWatch was releasing the semaphore permit immediately after sending
  // SIGTERM, before the CLI process (and its HTTP server) had fully exited. This allowed the
  // next test to acquire the permit and launch a new Chrome while the previous Chrome was still
  // shutting down — momentarily exceeding the concurrency cap.
  //
  // After the fix, shellWatch waits for the child to exit before releasing the permit. We verify
  // this by binding to the port the CLI server used: if the child is still alive it still holds
  // the port, so the bind fails.
  test('shellWatch releases the semaphore permit only after the child process has fully exited', async (assert) => {
    let cliPort: number | null = null;

    await shellWatch('node cli.ts test/helpers/passing-tests.ts --watch', {
      until: (buf) => {
        const match = buf.match(/http:\/\/localhost:(\d+)/);
        if (match && cliPort === null) cliPort = Number(match[1]);
        return buf.includes('Press "qq"');
      },
    });

    assert.ok(cliPort !== null, 'server URL appeared in shellWatch output');

    // Immediately after shellWatch returns the HTTP server port must be free.
    // The CLI's HTTP server is only released when the child process exits, so a
    // successful bind here proves the child has already exited.
    const portFree = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => {
        probe.close();
        resolve(true);
      });
      probe.listen(cliPort!);
    });

    assert.true(
      portFree,
      'HTTP server port is free immediately after shellWatch returns — child has fully exited before permit release',
    );
  });
});
