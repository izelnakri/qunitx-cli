import { module, test } from 'qunitx';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import '../helpers/custom-asserts.ts';
import shell, { shellFails } from '../helpers/shell.ts';

module('--port flag tests for browser mode', (_hooks, moduleMetadata) => {
  test('--port flag is accepted and tests complete successfully', async (assert, testMetadata) => {
    const result = await shell('node cli.ts tmp/test/passing-tests.js --port=5678', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.passingTestCaseFor(result, { moduleName: '{{moduleName}}' });
    assert.tapResult(result, { testCount: 3 });
  });

  test('--port flag combined with --debug shows the correct port in the server URL', async (assert, testMetadata) => {
    const result = await shell('node cli.ts tmp/test/passing-tests.js --port=5678 --debug', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.hasDebugURL(result, 'debug output includes the server URL with the assigned port');
    assert.passingTestCaseFor(result, { debug: true, moduleName: '{{moduleName}}' });
    assert.tapResult(result, { testCount: 3 });
  });

  test('default port 1234 is used when --port is not specified (visible in --debug output)', async (assert, testMetadata) => {
    const result = await shell('node cli.ts tmp/test/passing-tests.js --debug', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.regex(result, /# QUnitX running: http:\/\/localhost:1234\b/, 'server binds to port 1234 by default');
    assert.tapResult(result, { testCount: 3 });
  });

  test('auto-increments to 1235 when 1234 is taken (no --port)', async (assert, testMetadata) => {
    const blocker = await occupyPort(1234);
    try {
      const result = await shell('node cli.ts tmp/test/passing-tests.js --debug', {
        ...moduleMetadata,
        ...testMetadata,
      });

      assert.regex(result, /# QUnitX running: http:\/\/localhost:1235\b/, 'server bound to 1235 because 1234 was taken');
      assert.tapResult(result, { testCount: 3 });
    } finally {
      await releasePort(blocker);
    }
  });

  test('process truly occupies port 1234 while running (TCP connect succeeds)', async (assert) => {
    const boundPort = await withRunningServer(
      'node cli.ts tmp/test/passing-tests.js --watch',
      async (port) => {
        assert.equal(port, 1234, 'server URL reports port 1234');
        assert.ok(
          await portAcceptsConnections(1234),
          'TCP connect to port 1234 succeeds — process is truly listening',
        );
      },
    );

    assert.ok(await portIsFree(boundPort), 'port 1234 is released after the process exits');
  });

  test('process truly occupies port 1235 when 1234 is taken (TCP connect succeeds)', async (assert) => {
    const blocker = await occupyPort(1234);
    try {
      const boundPort = await withRunningServer(
        'node cli.ts tmp/test/passing-tests.js --watch',
        async (port) => {
          assert.equal(port, 1235, 'server URL reports port 1235');
          assert.ok(
            await portAcceptsConnections(1235),
            'TCP connect to port 1235 succeeds — process is truly listening',
          );
          assert.notOk(
            await portIsFree(1234),
            'port 1234 is still occupied by the blocker',
          );
        },
      );

      assert.ok(await portIsFree(boundPort), 'port 1235 is released after the process exits');
    } finally {
      await releasePort(blocker);
    }
  });

  test('fails with a clear error when --port is explicitly taken', async (assert, testMetadata) => {
    const blocker = await occupyPort(5679);
    try {
      const result = await shellFails(
        'node cli.ts tmp/test/passing-tests.js --port=5679',
        { ...moduleMetadata, ...testMetadata },
      );

      assert.exitCode(result, 1, 'should exit non-zero when the explicit port is in use');
    } finally {
      await releasePort(blocker);
    }
  });
});

// Occupies a port with a plain TCP server so we can simulate a conflict.
function occupyPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => resolve(server));
    server.listen(port, '127.0.0.1');
  });
}

function releasePort(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(resolve));
}

// Tries a TCP connect to confirm the port is accepting connections (server truly running).
function portAcceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

// Tries to bind to confirm the port is free (opposite of above).
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(); resolve(true); });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Starts qunitx in --watch mode, waits until the server is up (port appears in output),
 * calls `fn(port, stdout)` while the process is still running, then kills the process.
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

  const child = spawn(process.execPath, ['--experimental-strip-types', ...cmd.split(/\s+/).slice(1)]);

  let accum = '';
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`withRunningServer timed out for: ${cmd}`)), 45000);
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
