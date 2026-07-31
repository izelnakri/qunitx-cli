import { module, test } from 'qunitx';
import {
  Node,
  memoryHub,
  memoryStore,
  shardedRegistry,
  distributedSupervisor,
  superviseGenServer,
  type GenServer,
} from '../../lib/node/index.ts';

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
    const nodeA = Node.start('a@ds', hub.transport());
    const nodeB = Node.start('b@ds', hub.transport());
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

  test('a superviseGenServer child re-homes on node loss AND keeps its state via a shared store', async (assert) => {
    const hub = memoryHub();
    const store = memoryStore(); // one store shared by both hosts — stands in for a cluster DB
    const nodeA = Node.start('a@gs', hub.transport());
    const nodeB = Node.start('b@gs', hub.transport());
    const keys = ['acct-1', 'acct-2', 'acct-3', 'acct-4'];
    const counter = (node: typeof nodeA) =>
      distributedSupervisor(node, shardedRegistry(node), {
        name: 'ledgers',
        desired: keys,
        reconcileMs: 20,
        start: (key) =>
          superviseGenServer(
            node,
            key,
            {
              version: '1',
              init: () => 0,
              handlers: {
                deposit: (n, by) => ({ state: n + (by as number), reply: n + (by as number) }),
                balance: (n) => ({ state: n, reply: n }),
              },
            },
            { store, storeKey: key }, // durable — persist-before-ack, rehydrated by whoever hosts next
          ),
      });
    const supA = counter(nodeA);
    const supB = counter(nodeB);

    try {
      assert.true(
        await until(() => supA.hosted().length + supB.hosted().length === keys.length),
        'every ledger hosted exactly once across the cluster',
      );
      // Find a key that landed on B, deposit into it through the LOCAL typed handle, and confirm
      // the deposit persisted (durable-before-ack) so it can survive B's death.
      const onB = supB.hosted();
      assert.true(onB.length > 0, 'node B hosts some ledgers');
      const key = onB[0];
      const live = supB.local(key) as GenServer<number, 'deposit' | 'balance'>;
      assert.equal(await live.call('deposit', 100), 100, 'deposited 100 on B');
      assert.equal(await store.load(key), 100, 'the deposit is durable in the shared store');

      // Node B dies — supB.stop() gracefully tears down its hosts (state already durable), then B
      // leaves the roster so A re-homes B's keys. A fresh unit spins up on A and rehydrates the store.
      await supB.stop();
      nodeB.stop();
      assert.true(
        await until(() => supA.hosted().length === keys.length),
        'the survivor re-homed every ledger — all now on A',
      );
      assert.equal(await supA.whereis(key), 'a@gs', `re-homed ${key} now owned by A`);

      const migrated = supA.local(key) as GenServer<number, 'deposit' | 'balance'>;
      assert.equal(await migrated.call('balance'), 100, 'the re-homed unit rehydrated its balance');
      assert.equal(
        await migrated.call('deposit', 5),
        105,
        'and it keeps accumulating from the recovered state',
      );
    } finally {
      await supA.stop();
      nodeA.stop();
    }
  });

  test('crashOnError: a handler bug crashes the unit and the supervisor restarts it, rehydrated', async (assert) => {
    const hub = memoryHub();
    const store = memoryStore();
    const node = Node.start('solo@crash', hub.transport());
    let starts = 0;
    const sup = distributedSupervisor(node, shardedRegistry(node), {
      name: 'accts',
      desired: ['a1'],
      reconcileMs: 20,
      start: (key) => {
        starts += 1;
        return superviseGenServer(
          node,
          key,
          {
            version: '1',
            init: () => 0,
            handlers: {
              deposit: (n, by) => ({ state: n + (by as number), reply: n + (by as number) }),
              balance: (n) => ({ state: n, reply: n }),
              boom: () => {
                throw new Error('bug in handler'); // a non-Failure — a crash
              },
            },
          },
          { store, storeKey: key, crashOnError: true }, // let it crash → supervisor restarts it
        );
      },
    });
    const unit = () => sup.local('a1') as GenServer<number, 'deposit' | 'balance' | 'boom'>;

    try {
      assert.true(await until(() => sup.hosted().includes('a1')), 'a1 hosted');
      const before = starts;
      await unit().call('deposit', 50);
      assert.equal(await store.load('a1'), 50, 'the deposit is durable before the crash');

      // A bug crashes the unit; superviseGenServer's onExit tells the supervisor to restart it.
      const crashed = (await unit().call('boom').result()) as Failure.Any;
      assert.equal(crashed.code, 'UnitCrashed', 'the crashing caller got UnitCrashed');
      assert.true(
        await until(() => starts > before),
        'the supervisor restarted the crashed unit (a new start)',
      );
      assert.true(await until(() => sup.hosted().includes('a1')), 'a1 hosted again after restart');

      // The restarted unit rehydrated from the shared store — the balance survived the crash.
      assert.equal(
        await unit().call('balance'),
        50,
        'the restarted unit rehydrated its balance from the store',
      );
    } finally {
      await sup.stop();
      node.stop();
    }
  });

  test('restarts a child that crashes IN PLACE (onExit) while its node stays up', async (assert) => {
    const hub = memoryHub();
    const node = Node.start('solo@ip', hub.transport());
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
