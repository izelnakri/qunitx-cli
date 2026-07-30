import { module, test } from 'qunitx';
import { start, memoryHub, shardedRegistry, distributedSupervisor } from '../../lib/node/index.ts';

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (cond: () => boolean, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await settle(15);
  }
  return cond();
};

module('Node | distributedSupervisor (Horde DynamicSupervisor)', () => {
  test('spreads keyed children across nodes, one host each, and re-homes them on node loss', async (assert) => {
    const hub = memoryHub();
    const nodeA = start('a@ds', hub.transport());
    const nodeB = start('b@ds', hub.transport());
    const keys = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'];
    const supervised = (node: typeof nodeA) =>
      distributedSupervisor(node, shardedRegistry(node), {
        name: 'workers',
        desired: keys,
        reconcileMs: 20,
        start: (key) => ({ key, stop: () => {} }),
      });
    const supA = supervised(nodeA);
    const supB = supervised(nodeB);

    try {
      // Every key hosted on exactly one node (sum = 6), and the load is split across both.
      assert.true(
        await until(() => supA.hosted().length + supB.hosted().length === keys.length),
        'all keys hosted exactly once across the cluster',
      );
      assert.true(
        supA.hosted().length > 0 && supB.hosted().length > 0,
        'rendezvous spread the children across both nodes',
      );
      const onB = supB.hosted();
      assert.true(onB.length > 0, 'node B hosts some workers');

      // Node B dies — its workers must re-home to the survivor.
      await supB.stop();
      nodeB.stop();
      assert.true(
        await until(() => supA.hosted().length === keys.length),
        'the survivor re-homed the dead node’s workers — all 6 now on A',
      );
      for (const key of onB) {
        assert.equal(await supA.whereis(key), 'a@ds', `re-homed ${key} now owned by A`);
      }
    } finally {
      await supA.stop();
      nodeA.stop();
    }
  });

  test('restarts a child that crashes IN PLACE (onExit) while its node stays up', async (assert) => {
    const hub = memoryHub();
    const node = start('solo@ip', hub.transport());
    let starts = 0;
    let live: { stop(): void; onExit(fn: (r?: unknown) => void): void; crash(): void } | undefined;
    const sup = distributedSupervisor(node, shardedRegistry(node), {
      name: 'workers',
      desired: ['k1'],
      reconcileMs: 20,
      start: () => {
        starts += 1;
        let handler: ((reason?: unknown) => void) | undefined;
        live = {
          stop: () => {},
          onExit: (fn) => void (handler = fn),
          crash: () => handler?.(new Error('in-place crash')),
        };
        return live;
      },
    });
    try {
      assert.true(await until(() => sup.hosted().includes('k1')), 'k1 hosted here');
      const before = starts;
      live!.crash(); // crash in place — the node is still alive
      assert.true(
        await until(() => starts > before),
        'the crashed child was restarted in place (not just left dead until a re-home)',
      );
      assert.true(sup.hosted().includes('k1'), 'still hosted on this node');
    } finally {
      await sup.stop();
      node.stop();
    }
  });
});
