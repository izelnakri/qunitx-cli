import { module, test } from 'qunitx';
import http from 'node:http';
import HTTPServer from '../../lib/servers/http.js';

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

module('Servers | HTTPServer | query param routing', () => {
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
