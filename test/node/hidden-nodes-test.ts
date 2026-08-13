import { module, test } from 'qunitx';
import { Node, memoryHub, shardedRegistry, distributedSupervisor } from '../../lib/node/index.ts';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await settle(15);
  }
  return cond();
};

module('Node | hidden nodes (Erlang -hidden)', () => {
  test('a hidden node is excluded from list() but reachable via list(hidden|connected)', async (assert) => {
    const hub = memoryHub();
    const a = Node.start('a@h', hub.transport());
    const b = Node.start('b@h', hub.transport()); // visible member
    const obs = Node.start('obs@h', hub.transport(), { hidden: true }); // hidden observer
    await settle();

    assert.deepEqual(a.list().sort(), ['b@h'], 'default list() = visible members only');
    assert.deepEqual(a.list('hidden'), ['obs@h'], 'list(hidden) = the hidden nodes');
    assert.deepEqual(a.list('connected').sort(), ['b@h', 'obs@h'], 'list(connected) = both');
    assert.deepEqual(a.list('this'), ['a@h'], 'list(this) = self');
    assert.deepEqual(
      a.list('known').sort(),
      ['a@h', 'b@h', 'obs@h'],
      'list(known) = self + every connected peer',
    );

    // The observer is attached, not blind: it still sees the members it connected to.
    assert.deepEqual(obs.list('connected').sort(), ['a@h', 'b@h'], 'the observer sees the members');
    a.stop();
    b.stop();
    obs.stop();
  });

  test('rendezvous placement never lands on a hidden node — members exclude it from the roster', async (assert) => {
    const hub = memoryHub();
    const a = Node.start('a@h', hub.transport());
    const b = Node.start('b@h', hub.transport());
    const obs = Node.start('obs@h', hub.transport(), { hidden: true }); // connected, but an observer
    await settle();
    const keys = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'];
    // Only the MEMBERS run the app's distributed supervisor — an observer just watches.
    const sup = (node: typeof a) =>
      distributedSupervisor(node, shardedRegistry(node), {
        name: 'w',
        desired: keys,
        reconcileMs: 20,
        start: (key) => ({ key, stop: () => {} }),
      });
    const supA = sup(a);
    const supB = sup(b);

    try {
      assert.true(
        await until(() => supA.hosted().length + supB.hosted().length === keys.length),
        'every key is placed across the visible members',
      );
      for (const key of keys) {
        const owner = await supA.whereis(key);
        assert.true(
          owner === 'a@h' || owner === 'b@h',
          `${key} is owned by a visible member (${owner}), never the hidden observer`,
        );
      }
    } finally {
      await supA.stop();
      await supB.stop();
      a.stop();
      b.stop();
      obs.stop();
    }
  });

  test('monitorNodes filters by node_type — default visible, opt into hidden / all', async (assert) => {
    const hub = memoryHub();
    const a = Node.start('a@h', hub.transport());
    const visibleUps: string[] = [];
    const hiddenUps: string[] = [];
    const allUps: string[] = [];
    a.monitorNodes((e) => {
      if (e.status === 'up') visibleUps.push(e.node);
    }); // default node_type: visible
    a.monitorNodes(
      (e) => {
        if (e.status === 'up') hiddenUps.push(e.node);
      },
      { nodeType: 'hidden' },
    );
    a.monitorNodes(
      (e) => {
        if (e.status === 'up') allUps.push(e.node);
      },
      { nodeType: 'all' },
    );

    const b = Node.start('b@h', hub.transport()); // visible join
    const obs = Node.start('obs@h', hub.transport(), { hidden: true }); // hidden join
    await settle(30);

    assert.deepEqual(visibleUps, ['b@h'], 'the visible listener saw only the visible join');
    assert.deepEqual(hiddenUps, ['obs@h'], 'the hidden listener saw only the hidden join');
    assert.deepEqual(allUps.sort(), ['b@h', 'obs@h'], 'the all listener saw both');
    a.stop();
    b.stop();
    obs.stop();
  });

  test('a hidden node still participates in process groups (:pg parity)', async (assert) => {
    const hub = memoryHub();
    const a = Node.start('a@h', hub.transport());
    const obs = Node.start('obs@h', hub.transport(), { hidden: true });
    await settle();
    obs.join('workers'); // pg includes hidden nodes — unlike :global / placement
    await settle();

    assert.deepEqual(
      a.groupMembers('workers'),
      ['obs@h'],
      'the hidden node is a group member — pg does NOT exclude hidden',
    );
    a.stop();
    obs.stop();
  });
});
