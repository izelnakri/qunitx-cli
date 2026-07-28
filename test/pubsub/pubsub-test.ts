import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { pubsub } from '../../lib/pubsub/index.ts';

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

module('PubSub | Phoenix.PubSub', () => {
  test('a local subscriber receives a same-node broadcast', async (assert) => {
    const node = Node.start('a@ps', Node.memoryHub().transport());
    const ps = pubsub(node);
    const got: string[] = [];
    ps.subscribe('news', (event, payload) => got.push(`${event}:${payload}`));
    ps.broadcast('news', 'headline', 'hi');
    await settle();
    assert.deepEqual(got, ['headline:hi']);
    node.stop();
  });

  test('a broadcast reaches subscribers on ANOTHER node', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@ps', hub.transport());
    const b = Node.start('b@ps', hub.transport());
    const psB = pubsub(b);
    const got: unknown[] = [];
    psB.subscribe('room:1', (_e, payload) => got.push(payload));
    await settle(); // b's group-join gossips to a

    pubsub(a).broadcast('room:1', 'msg', { text: 'cross-node' });
    await settle();
    assert.deepEqual(got, [{ text: 'cross-node' }], 'delivered across the cluster');
    a.stop();
    b.stop();
  });

  test('broadcastFrom excludes the origin node', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@ps', hub.transport());
    const b = Node.start('b@ps', hub.transport());
    const psA = pubsub(a);
    const psB = pubsub(b);
    const onA: unknown[] = [];
    const onB: unknown[] = [];
    psA.subscribe('t', (_e, p) => onA.push(p));
    psB.subscribe('t', (_e, p) => onB.push(p));
    await settle();

    psA.broadcastFrom('t', 'e', 'payload');
    await settle();
    assert.deepEqual(onA, [], 'the origin does not receive its own broadcastFrom');
    assert.deepEqual(onB, ['payload'], 'other nodes still do');
    a.stop();
    b.stop();
  });

  test('unsubscribe stops delivery; multiple subscribers each get it', async (assert) => {
    const node = Node.start('a@ps', Node.memoryHub().transport());
    const ps = pubsub(node);
    const one: number[] = [];
    const two: number[] = [];
    const off = ps.subscribe('c', () => one.push(1));
    ps.subscribe('c', () => two.push(2));
    ps.broadcast('c', 'e');
    await settle();
    off();
    ps.broadcast('c', 'e');
    await settle();
    assert.deepEqual(one, [1], 'unsubscribed handler stopped after one');
    assert.deepEqual(two, [2, 2], 'the other kept receiving');
    node.stop();
  });
});
