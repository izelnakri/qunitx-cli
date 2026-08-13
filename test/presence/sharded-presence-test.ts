import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { rendezvous } from '../../lib/node/index.ts';
import { shardedPresence } from '../../lib/presence/index.ts';

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

module('Presence | sharded (partitioned)', () => {
  test('track routes to a coordinator; list from any node reads it', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@sp', hub.transport());
    const b = Node.start('b@sp', hub.transport());
    // Every node runs a tracker at boot — that's what registers the coordinator handlers.
    const prA = shardedPresence(a);
    const prB = shardedPresence(b);
    await settle();

    await prA.track('room:1', 'ada', { role: 'host' });
    await settle();
    assert.deepEqual(
      await prB.list('room:1'),
      { ada: { metas: [{ role: 'host' }] } },
      'the entry is readable from the other node (routed to the coordinator)',
    );
    a.stop();
    b.stop();
  });

  test('the coordinator prunes a downed owner (fixed coordinator)', async (assert) => {
    const hub = Node.memoryHub();
    const only = () => ['coord@sp'];
    const coord = Node.start('coord@sp', hub.transport());
    const a = Node.start('a@sp', hub.transport());
    const b = Node.start('b@sp', hub.transport());
    shardedPresence(coord, { peers: only }); // the coordinator registers its handlers + prune monitor
    const prA = shardedPresence(a, { peers: only });
    const prB = shardedPresence(b, { peers: only });
    await settle();

    await prA.track('room:1', 'ada', {});
    await settle();
    assert.deepEqual(Object.keys(await prB.list('room:1')), ['ada']);

    a.stop(); // owner down → coordinator's monitor prunes ada
    await settle();
    assert.deepEqual(await prB.list('room:1'), {}, "the downed owner's presence was pruned");
    coord.stop();
    b.stop();
  });

  test('presence re-homes when a joining node becomes the topic coordinator', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@sp', hub.transport());
    const b = Node.start('b@sp', hub.transport());
    const prA = shardedPresence(a);
    shardedPresence(b);
    await settle();
    // Find a topic that rendezvous assigns to the newcomer c once it joins.
    let topic = '';
    for (let i = 0; i < 500; i++) {
      const t = `room:${i}`;
      if (
        rendezvous(t, ['a@sp', 'b@sp']) !== 'c@sp' &&
        rendezvous(t, ['a@sp', 'b@sp', 'c@sp']) === 'c@sp'
      ) {
        topic = t;
        break;
      }
    }
    assert.notEqual(topic, '', 'found a topic that moves to c');

    await prA.track(topic, 'ada', { v: 1 });
    await settle();

    const c = Node.start('c@sp', hub.transport());
    const prC = shardedPresence(c); // c boots its tracker → handlers ready before a re-homes to it
    await settle(150); // membership converges + re-home fires

    assert.deepEqual(
      await prC.list(topic),
      { ada: { metas: [{ v: 1 }] } },
      'the presence followed the shard to the new coordinator',
    );
    a.stop();
    b.stop();
    c.stop();
  });
});
