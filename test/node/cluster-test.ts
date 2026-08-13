import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { cluster } from '../../lib/node/index.ts';

module('Node | cluster formation', { concurrency: true }, () => {
  test('poll dials newly-discovered peers once and drops departed ones', async (assert) => {
    const dialed: string[] = [];
    const dropped: string[] = [];
    let peers = ['a@host', 'b@host'];
    const c = cluster({
      strategy: () => peers,
      connect: (p) => void dialed.push(p),
      disconnect: (p) => void dropped.push(p),
    });

    await c.poll();
    assert.deepEqual(dialed, ['a@host', 'b@host'], 'both dialed on first sight');

    await c.poll(); // idempotent — nothing new
    assert.deepEqual(dialed, ['a@host', 'b@host'], 'a second poll dials nothing again');

    peers = ['a@host', 'b@host', 'c@host'];
    await c.poll();
    assert.deepEqual(dialed, ['a@host', 'b@host', 'c@host'], 'only the newcomer is dialed');

    peers = ['a@host', 'c@host']; // b left
    await c.poll();
    assert.deepEqual(dropped, ['b@host'], 'the departed peer is disconnected');
    assert.deepEqual(c.connected().sort(), ['a@host', 'c@host'], 'connected set tracks discovery');
  });

  test('self is never dialed', async (assert) => {
    const dialed: string[] = [];
    const c = cluster({
      strategy: () => ['n@1', 'n@2'],
      connect: (p) => void dialed.push(p),
      self: 'n@1',
    });
    await c.poll();
    assert.deepEqual(dialed, ['n@2'], 'the node does not connect to itself');
  });

  test('an async strategy (a DNS/API lookup) is awaited', async (assert) => {
    const dialed: string[] = [];
    const c = cluster({
      strategy: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return ['x@svc'];
      },
      connect: (p) => void dialed.push(p),
    });
    await c.poll();
    assert.deepEqual(dialed, ['x@svc'], 'the resolved peer set is used');
  });

  test('formation wires a real cluster: discovered peers become Node.list peers', async (assert) => {
    // The strategy reports node names; connect() hands each a hub transport and starts it. This is
    // the in-process shape of libcluster dialing WebSocket peers in production.
    const hub = Node.memoryHub();
    const started = new Map<string, Node.NodeHandle>();
    const seed = Node.start('seed@mesh', hub.transport());
    const c = cluster({
      strategy: () => ['n1@mesh', 'n2@mesh'],
      connect: (name) => void started.set(name, Node.start(name, hub.transport())),
      self: 'seed@mesh',
    });
    await c.poll();
    await new Promise((r) => setTimeout(r, 30)); // hellos gossip across the hub

    assert.deepEqual(
      seed.list().sort(),
      ['n1@mesh', 'n2@mesh'],
      'the seed sees both auto-connected nodes as peers',
    );
    seed.stop();
    for (const node of started.values()) node.stop();
  });
});
