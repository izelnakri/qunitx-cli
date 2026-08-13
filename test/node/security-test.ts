import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { startHub } from '../../lib/node/hub.ts';
import { Failure } from '../../lib/result/index.ts';

const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));

// Distribution security: the hub's HMAC challenge-response (Erlang's magic cookie) closes the "any
// socket joins the cluster" hole, and the node-level `authorize` hook gates per message. The hub
// tests are node-lane only (the hub stands on the `ws` package + node:https).
module('Node | distribution security', () => {
  test('matching secret: challenge-response lets the node join and call', async (assert) => {
    if ('Deno' in globalThis) {
      assert.true(true, 'skipped under Deno — the hub is node-lane');
      return;
    }
    const hub = startHub({ port: 0, secret: 'cluster-cookie' });
    const url = `ws://127.0.0.1:${hub.port()}`;
    const a = Node.start('a@sec', Node.wsTransport(url, { secret: 'cluster-cookie' }));
    const b = Node.start('b@sec', Node.wsTransport(url, { secret: 'cluster-cookie' }));
    b.handle('echo', (m) => m);
    await settle(250);
    assert.strictEqual(
      await a.call('b@sec', 'echo', 'hi', 2000),
      'hi',
      'the authenticated call crossed the wire',
    );
    a.stop();
    b.stop();
    await hub.close();
  });

  test('wrong secret: the socket is dropped and cannot reach the cluster', async (assert) => {
    if ('Deno' in globalThis) {
      assert.true(true, 'skipped under Deno');
      return;
    }
    const hub = startHub({ port: 0, secret: 'right-cookie' });
    const url = `ws://127.0.0.1:${hub.port()}`;
    const good = Node.start('good@sec', Node.wsTransport(url, { secret: 'right-cookie' }));
    good.handle('ping', () => 'pong');
    // The impostor presents the wrong cookie — the hub terminates it on the bad proof.
    const bad = Node.start('bad@sec', Node.wsTransport(url, { secret: 'wrong-cookie' }));
    await settle(250);
    const outcome = await bad.call('good@sec', 'ping', undefined, 400).result();
    assert.true(Failure.is(outcome), 'the unauthenticated node could not reach the cluster');
    good.stop();
    bad.stop();
    await hub.close();
  });

  test('authorize denies a call with Unauthorized and drops a denied cast', async (assert) => {
    // Pure node-level gate — works over any transport, so memoryHub, no Deno guard needed.
    const hub = Node.memoryHub();
    let opened = 0;
    let secreted = 0;
    const server = Node.start('srv@authz', hub.transport(), {
      authorize: ({ subject }) => !subject.startsWith('secret'),
    });
    server.handle('open', () => 'ok');
    server.handle('secret', () => 'leaked');
    server.handle('openCast', () => (opened += 1));
    server.handle('secretCast', () => (secreted += 1));
    const client = Node.start('cli@authz', hub.transport());
    await settle();

    assert.strictEqual(await client.call('srv@authz', 'open'), 'ok', 'an allowed call passes');
    const denied = await client.call('srv@authz', 'secret').result();
    assert.true(Failure.is(denied), 'a denied call is a failure, not a leak');
    assert.strictEqual((denied as Failure.Any).code, 'Unauthorized', 'with the declared code');

    client.cast('srv@authz', 'openCast'); // allowed
    client.cast('srv@authz', 'secretCast'); // denied
    await settle();
    assert.strictEqual(opened, 1, 'the allowed cast ran');
    assert.strictEqual(secreted, 0, 'the denied cast was dropped');

    server.stop();
    client.stop();
  });
});
