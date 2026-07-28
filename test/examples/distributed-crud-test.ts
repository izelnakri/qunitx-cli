import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { rateLimiter } from '../../lib/node/index.ts';
import { nodeListen } from '../../lib/router/node.ts';
import { startCrudHost, crudApp, type Todo } from '../../examples/distributed-crud/src/server.ts';

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

// The whole shape over REAL HTTP: two stateless Express-look gateways, one entity host, a shared
// store. A row written through one gateway is read through the other (via-routing to its single
// owner actor), the index converges, and a dead host's rows rehydrate on a replacement.
module('Examples | distributed CRUD server', () => {
  test('CRUD through two gateways: one row owner, cross-node reads, index, 404 after delete', async (assert) => {
    const hub = Node.memoryHub();
    const store = Node.memoryStore();
    const host = startCrudHost('host@crud', hub.transport(), store);
    const gw1 = Node.start('gw1@crud', hub.transport());
    const gw2 = Node.start('gw2@crud', hub.transport());
    const http1 = nodeListen(crudApp(gw1), 0);
    const http2 = nodeListen(crudApp(gw2), 0);
    const base1 = `http://127.0.0.1:${http1.port()}`;
    const base2 = `http://127.0.0.1:${http2.port()}`;
    await settle();

    // CREATE via gateway 1.
    const created = await fetch(`${base1}/todos`, {
      method: 'POST',
      body: JSON.stringify({ title: 'ship it' }),
    });
    assert.equal(created.status, 201);
    const todo = (await created.json()) as Todo;
    assert.equal(todo.title, 'ship it');

    // READ via gateway 2 — a different node; the call routes to the ONE owner actor.
    const read = await fetch(`${base2}/todos/${todo.id}`);
    assert.deepEqual(await read.json(), todo, 'cross-gateway read hits the same entity');

    // UPDATE via gateway 1; read back via gateway 2 — single-owner writes never race.
    await fetch(`${base1}/todos/${todo.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ done: true }),
    });
    const after = (await (await fetch(`${base2}/todos/${todo.id}`)).json()) as Todo;
    assert.true(after.done, 'the patch is visible from every gateway');

    // LIST — the index actor converged with the create.
    await settle();
    const list = (await (await fetch(`${base2}/todos`)).json()) as Todo[];
    assert.deepEqual(
      list.map((t) => t.id),
      [todo.id],
      'the collection index lists the row',
    );

    // DELETE via gateway 2 → 404 via gateway 1, and the row is durably gone.
    assert.equal((await fetch(`${base2}/todos/${todo.id}`, { method: 'DELETE' })).status, 204);
    await settle();
    assert.equal((await fetch(`${base1}/todos/${todo.id}`)).status, 404, 'deleted everywhere');

    await http1.close();
    await http2.close();
    await host.stop();
    gw1.stop();
    gw2.stop();
  });

  test('load protection: requests past the budget get 429, within it succeed', async (assert) => {
    const hub = Node.memoryHub();
    const store = Node.memoryStore();
    const host = startCrudHost('host@crud', hub.transport(), store);
    const gw = Node.start('gw@crud', hub.transport());
    const clock = { t: 0 };
    const app = crudApp(gw, {
      limiter: rateLimiter({ capacity: 2, refillPerSec: 1, now: () => clock.t }),
    });
    await settle();

    assert.equal((await app.fetch(new Request('http://x/todos'))).status, 200, '1 of 2');
    assert.equal((await app.fetch(new Request('http://x/todos'))).status, 200, '2 of 2');
    assert.equal(
      (await app.fetch(new Request('http://x/todos'))).status,
      429,
      'the burst is spent — throttled at the edge, never reaching the actors',
    );
    await host.stop();
    gw.stop();
  });

  test('durability: the entity host dies; a replacement rehydrates rows from the shared store', async (assert) => {
    const hub = Node.memoryHub();
    const store = Node.memoryStore(); // ONE shared store = the shared Postgres in production
    const host1 = startCrudHost('host1@crud', hub.transport(), store);
    const gw = Node.start('gw@crud', hub.transport());
    const app = crudApp(gw);
    await settle();

    const created = (await (
      await app.fetch(
        new Request('http://x/todos', {
          method: 'POST',
          body: JSON.stringify({ title: 'survive' }),
        }),
      )
    ).json()) as Todo;

    await host1.stop(); // the data plane node dies — rows gone from memory
    const host2 = startCrudHost('host2@crud', hub.transport(), store);
    await settle();

    const revived = await app.fetch(new Request(`http://x/todos/${created.id}`));
    assert.equal(revived.status, 200, 'the row came back on the NEW host');
    assert.deepEqual(
      ((await revived.json()) as Todo).title,
      'survive',
      'rehydrated from the shared store — persist-before-ack made it durable',
    );
    await host2.stop();
    gw.stop();
  });
});
