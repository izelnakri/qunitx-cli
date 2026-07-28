import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { pubsub } from '../../lib/pubsub/index.ts';
import { distributedCache } from '../../lib/cache/index.ts';

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

module('Cache | distributed (LWWMap over PubSub)', () => {
  test('a write on one node converges to another', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@c', hub.transport());
    const b = Node.start('b@c', hub.transport());
    const cacheA = distributedCache<{ name: string }>(a, pubsub(a));
    const cacheB = distributedCache<{ name: string }>(b, pubsub(b));
    await settle();

    cacheA.set('user:1', { name: 'ada' });
    assert.deepEqual(cacheA.get('user:1'), { name: 'ada' }, 'immediate on the writer');
    await settle();
    assert.deepEqual(cacheB.get('user:1'), { name: 'ada' }, 'converged to the other node');
    a.stop();
    b.stop();
  });

  test('an invalidation (delete) converges cluster-wide', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@c', hub.transport());
    const b = Node.start('b@c', hub.transport());
    const cacheA = distributedCache<number>(a, pubsub(a));
    const cacheB = distributedCache<number>(b, pubsub(b));
    await settle();
    cacheA.set('n', 7);
    await settle();
    assert.equal(cacheB.get('n'), 7);

    cacheB.delete('n'); // invalidate on the OTHER node
    await settle();
    assert.equal(cacheA.get('n'), undefined, 'the tombstone converged — no stale read anywhere');
    assert.deepEqual(cacheA.keys(), [], 'deleted keys drop out of keys()');
    a.stop();
    b.stop();
  });

  test('concurrent writes resolve last-writer-wins on both nodes', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@c', hub.transport());
    const b = Node.start('b@c', hub.transport());
    const cacheA = distributedCache<string>(a, pubsub(a));
    const cacheB = distributedCache<string>(b, pubsub(b));
    await settle();
    const t = Date.now();
    cacheA.set('k', 'stale', t + 100);
    cacheB.set('k', 'fresh', t + 200); // newer timestamp wins
    await settle();
    assert.equal(cacheA.get('k'), 'fresh', 'node A took the newer write');
    assert.equal(cacheB.get('k'), 'fresh', 'and so did node B — deterministic');
    a.stop();
    b.stop();
  });

  test('a TTL expires locally on read', async (assert) => {
    const node = Node.start('n@c', Node.memoryHub().transport());
    const cache = distributedCache<number>(node, pubsub(node), { ttlMs: 30 });
    cache.set('x', 1);
    assert.equal(cache.get('x'), 1, 'live before expiry');
    await settle(60);
    assert.equal(cache.get('x'), undefined, 'expired after its TTL');
    node.stop();
  });
});
