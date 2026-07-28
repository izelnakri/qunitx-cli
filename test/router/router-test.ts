import { module, test } from 'qunitx';
import { router, json } from '../../lib/router/index.ts';

module('Router | Express-shaped, web-standard', { concurrency: true }, () => {
  test('routes by method and path; params and query are parsed', async (assert) => {
    const app = router();
    app.get('/todos/:id', (req) => json({ id: req.params.id, full: req.query.full }));
    const res = await app.fetch(new Request('http://x/todos/42?full=yes'));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: '42', full: 'yes' });
  });

  test('POST reads a JSON body; unmatched paths 404; wrong method 404s too', async (assert) => {
    const app = router();
    app.post('/todos', async (req) => json({ made: await req.json() }, 201));
    const created = await app.fetch(
      new Request('http://x/todos', { method: 'POST', body: JSON.stringify({ title: 'ship' }) }),
    );
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { made: { title: 'ship' } });
    assert.equal((await app.fetch(new Request('http://x/nope'))).status, 404);
    assert.equal(
      (await app.fetch(new Request('http://x/todos'))).status,
      404,
      'GET /todos unregistered',
    );
  });

  test('middleware composes in order and can short-circuit or decorate', async (assert) => {
    const app = router();
    const order: string[] = [];
    app.use((req, next) => {
      order.push('auth');
      if (req.headers.get('authorization') !== 'yes') return json({ error: 'nope' }, 401);
      return next();
    });
    app.use(async (_req, next) => {
      order.push('time');
      const res = await next();
      res.headers.set('x-timed', 'true');
      return res;
    });
    app.get('/secret', () => (order.push('route'), json({ ok: true })));

    const denied = await app.fetch(new Request('http://x/secret'));
    assert.equal(denied.status, 401, 'short-circuited before the route');
    const allowed = await app.fetch(
      new Request('http://x/secret', { headers: { authorization: 'yes' } }),
    );
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('x-timed'), 'true', 'decorated on the way out');
    assert.deepEqual(order, ['auth', 'auth', 'time', 'route'], 'layers ran in registration order');
  });

  test('a throwing handler becomes a JSON 500 with no leaked detail', async (assert) => {
    const app = router();
    app.get('/boom', () => {
      throw new Error('secret stack');
    });
    const res = await app.fetch(new Request('http://x/boom'));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal error' });
  });

  test('wildcard routes swallow the rest of the path', async (assert) => {
    const app = router();
    app.get('/assets/*', (req) => json({ path: new URL(req.url).pathname }));
    const res = await app.fetch(new Request('http://x/assets/deep/file.css'));
    assert.deepEqual(await res.json(), { path: '/assets/deep/file.css' });
  });
});
