import { module, test } from 'qunitx';
import http from 'node:http';
import net from 'node:net';
// @deno-types="npm:@types/ws"
import WebSocket from 'ws';
import HTTPServer from '../../lib/servers/web.ts';
import bindServerToPort from '../../lib/setup/bind-server-to-port.ts';

module('Servers | bindServerToPort | port selection', { concurrency: true }, () => {
  test('binds to the requested port when it is free', async (assert) => {
    const server = new HTTPServer();
    const blocker = await findFreePort();
    const port = blocker.number;
    await blocker.release();

    const config = { port };
    await bindServerToPort(server, config);
    assert.equal(config.port, port, 'config.port is updated to the bound port');
    await server.close();
  });

  test('auto-increments to port+1 when the requested port is taken (portExplicit not set)', async (assert) => {
    const blocker = await findFreePort();
    const takenPort = blocker.number;
    // Keep blocker running so takenPort stays occupied
    const next = new HTTPServer();
    const config = { port: takenPort };
    await bindServerToPort(next, config);
    assert.ok(config.port > takenPort, 'binds to a port higher than the taken port');
    await blocker.release();
    await next.close();
  });

  test('throws EADDRINUSE when portExplicit is true and the port is taken', async (assert) => {
    const blocker = await findFreePort();
    const takenPort = blocker.number;
    const server = new HTTPServer();
    try {
      await bindServerToPort(server, { port: takenPort, portExplicit: true });
      assert.ok(false, 'should have thrown');
    } catch (err: unknown) {
      assert.equal(
        (err as NodeJS.ErrnoException).code,
        'EADDRINUSE',
        'throws EADDRINUSE for explicit taken port',
      );
    } finally {
      await blocker.release();
      server._server.close();
    }
  });
});

module('Servers | HTTPServer | query param routing', { concurrency: true }, () => {
  test('GET / serves correctly without query params', async (assert) => {
    await withServer(async (port) => {
      const { statusCode, body } = await request(port, '/');

      assert.equal(statusCode, 200);
      assert.deepEqual(JSON.parse(body.replace('query:', '')), {});
    });
  });

  test('GET /?testId=xxx matches the / route and returns 200', async (assert) => {
    await withServer(async (port) => {
      const { statusCode } = await request(port, '/?testId=ac543e5a');

      assert.equal(statusCode, 200);
    });
  });

  test('GET /?moduleId=xxx matches the / route and returns 200', async (assert) => {
    await withServer(async (port) => {
      const { statusCode } = await request(port, '/?moduleId=f0109ef0');

      assert.equal(statusCode, 200);
    });
  });

  test('GET /?filter=xxx matches the / route and returns 200', async (assert) => {
    await withServer(async (port) => {
      const { statusCode } = await request(port, '/?filter=some+test+name');

      assert.equal(statusCode, 200);
    });
  });

  test('req.query is populated with parsed query params', async (assert) => {
    await withServer(async (port) => {
      const { statusCode, body } = await request(port, '/?testId=ac543e5a&moduleId=f0109ef0');

      assert.equal(statusCode, 200);
      assert.deepEqual(JSON.parse(body.replace('query:', '')), {
        testId: 'ac543e5a',
        moduleId: 'f0109ef0',
      });
    });
  });
});

module('Servers | HTTPServer | close()', { concurrency: true }, () => {
  test('close() terminates all connected WebSocket clients', async (assert) => {
    const server = new HTTPServer();
    server.get('/', (_req, res) => res.end('ok'));
    await server.listen(0);
    const port = (server._server.address() as net.AddressInfo).port;

    // Connect two clients and wait for both to be fully open.
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await Promise.all([
      new Promise<void>((r) => ws1.once('open', r)),
      new Promise<void>((r) => ws2.once('open', r)),
    ]);

    // Capture close events before calling server.close() so we don't miss them.
    const close1 = new Promise<void>((r) => ws1.once('close', r));
    const close2 = new Promise<void>((r) => ws2.once('close', r));

    await server.close();

    // Both clients must receive the close event — the Promise would hang
    // if server.close() left any WebSocket connections open.
    await Promise.all([close1, close2]);

    assert.strictEqual(ws1.readyState, WebSocket.CLOSED, 'first client is closed');
    assert.strictEqual(ws2.readyState, WebSocket.CLOSED, 'second client is closed');
  });

  test('close() resolves only after the server stops accepting new connections', async (assert) => {
    const server = new HTTPServer();
    await server.listen(0);
    const port = (server._server.address() as net.AddressInfo).port;

    await server.close();

    // Any connection attempt after close() must fail; the port is no longer bound.
    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        const sock = net.createConnection({ port, host: '127.0.0.1' });
        sock.once('connect', () => {
          sock.destroy();
          // If we somehow connected, the server wasn't fully closed — test should fail.
          resolve();
        });
        sock.once('error', reject);
      }),
      /ECONNREFUSED/,
      'port is no longer accessible after close()',
    );
  });
});

// Finds a free OS-assigned port by binding to :0, then releases it.
// Returns { number, release } so callers can hold it open or release immediately.
function findFreePort(): Promise<{ number: number; release: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      const number = (server.address() as net.AddressInfo).port;
      resolve({ number, release: () => new Promise((res) => server.close(res)) });
    });
    server.listen(0);
  });
}

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

async function withServer(fn) {
  const server = new HTTPServer();
  server.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`query:${JSON.stringify(req.query)}`);
  });
  await server.listen(0);
  const port = server._server.address().port;
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server._server.close(resolve));
  }
}
