import { module, test } from 'qunitx';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import '../helpers/custom-asserts.ts';
import shell, { shellFails } from '../helpers/shell.ts';

module('--port flag tests for browser mode', (_hooks, moduleMetadata) => {
  test('--port flag is accepted and tests complete successfully', async (assert, testMetadata) => {
    const { number: port, release } = await findFreePort();
    await release();
    const result = await shell(`node cli.ts tmp/test/passing-tests.js --port=${port}`, {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.passingTestCaseFor(result, { moduleName: '{{moduleName}}' });
    assert.tapResult(result, { testCount: 3 });
  });

  test('--port flag combined with --debug shows the correct port in the server URL', async (assert, testMetadata) => {
    const { number: port, release } = await findFreePort();
    await release();
    const result = await shell(`node cli.ts tmp/test/passing-tests.js --port=${port} --debug`, {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.hasDebugURL(result, 'debug output includes the server URL with the assigned port');
    assert.regex(
      result,
      new RegExp(`# QUnitX running: http://localhost:${port}\\b`),
      'URL shows the explicitly requested port',
    );
    assert.passingTestCaseFor(result, { debug: true, moduleName: '{{moduleName}}' });
    assert.tapResult(result, { testCount: 3 });
  });

  test('process truly occupies the bound port while running (TCP connect succeeds)', async (assert) => {
    // Use a dynamically found free port via --port so the test is isolated from concurrent runs.
    const free = await findFreePort();
    const port = free.number;
    await free.release();

    const boundPort = await withRunningServer(
      `node cli.ts tmp/test/passing-tests.js --watch --port=${port}`,
      async (actualPort) => {
        assert.equal(actualPort, port, 'server URL reports the requested port');
        assert.ok(
          await portAcceptsConnections(actualPort),
          'TCP connect succeeds — process is truly listening on that port',
        );
      },
    );

    assert.ok(await portIsFree(boundPort), 'port is released after the process exits');
  });

  test('fails with a clear error when --port is explicitly taken', async (assert, testMetadata) => {
    const free = await findFreePort();
    const takenPort = free.number;
    // Keep it occupied for the duration of the test.
    try {
      const result = await shellFails(`node cli.ts tmp/test/passing-tests.js --port=${takenPort}`, {
        ...moduleMetadata,
        ...testMetadata,
      });

      assert.exitCode(result, 1, 'should exit non-zero when the explicit port is in use');
    } finally {
      await free.release();
    }
  });
});

// Finds a free OS-assigned port by binding to :: (all interfaces) to match how the CLI binds.
// Returns { number, release }. Caller can hold the server open to occupy the port, or call
// release() immediately to free it.
function findFreePort(): Promise<{ number: number; release: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      const number = (server.address() as net.AddressInfo).port;
      resolve({ number, release: () => new Promise((res) => server.close(res)) });
    });
    // Bind :: (all interfaces) to match the CLI's bind address, so the occupied check is
    // consistent with how the CLI claims the port. Binding 127.0.0.1 here while the CLI
    // binds :: would not reserve the port on the :: side, causing a false-free detection.
    server.listen(0, '::');
  });
}

// Tries a TCP connect to confirm the port is accepting connections (server truly running).
function portAcceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

// Tries to bind to confirm the port is free.
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Starts qunitx in --watch mode, waits until the server URL appears in output,
 * calls `fn(port)` while the process is still running, then kills the process.
 * Returns the port that was bound.
 */
async function withRunningServer(
  command: string,
  fn: (port: number, stdout: string) => Promise<void>,
): Promise<number> {
  let cmd = command;
  if (/\bnode cli\.ts\b/.test(cmd) && !/--output/.test(cmd)) {
    cmd = `${cmd} --output=tmp/run-${randomUUID()}`;
  }

  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    ...cmd.split(/\s+/).slice(1),
  ]);

  let accum = '';
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`withRunningServer timed out for: ${cmd}`)),
      45000,
    );
    child.stdout.on('data', (chunk: Buffer) => {
      accum += chunk.toString();
      const match = accum.match(/http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.resume();
    child.on('error', reject);
  });

  try {
    await fn(port, accum);
  } finally {
    child.kill('SIGTERM');
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    // Give the OS a moment to release the port after SIGTERM.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return port;
}
