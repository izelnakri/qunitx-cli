import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { shardedRegistry } from '../../lib/node/index.ts';

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

module('Node | sharded registry (partitioned, frontier #1)', () => {
  test('a duplicate claim is rejected SYNCHRONOUSLY with the current owner', async (assert) => {
    const hub = Node.memoryHub();
    const coord = Node.start('coord@sr', hub.transport());
    const a = Node.start('a@sr', hub.transport());
    const b = Node.start('b@sr', hub.transport());
    const only = () => ['coord@sr']; // pin every key to one coordinator
    shardedRegistry(coord, { peers: only });
    const regA = shardedRegistry(a, { peers: only });
    const regB = shardedRegistry(b, { peers: only });
    await settle();

    assert.deepEqual(await regA.register('svc', 'leader'), { ok: true }, 'first claim wins');
    assert.deepEqual(
      await regB.register('svc', 'leader'),
      { error: 'taken', owner: 'a@sr' },
      'the duplicate is REJECTED at claim time — Elixir local-Registry semantics, cluster-wide',
    );
    assert.deepEqual(
      await regA.register('svc', 'leader'),
      { ok: true },
      're-claiming your own key is a no-op',
    );

    await regA.unregister('svc', 'leader');
    assert.deepEqual(
      await regB.register('svc', 'leader'),
      { ok: true },
      'released keys are claimable',
    );
    coord.stop();
    a.stop();
    b.stop();
  });

  test('whereis routes to the coordinator; keys() scatter-gathers across all shards', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@sr', hub.transport());
    const b = Node.start('b@sr', hub.transport());
    const regA = shardedRegistry(a);
    const regB = shardedRegistry(b);
    await settle();

    // Spread keys across BOTH coordinators (rendezvous will split them).
    for (const key of ['alpha', 'bravo', 'charlie', 'delta']) await regA.register('rooms', key);
    await settle();

    assert.equal(await regB.whereis('rooms', 'alpha'), 'a@sr', 'whereis answers from any node');
    assert.deepEqual(
      (await regB.keys('rooms')).sort(),
      ['alpha', 'bravo', 'charlie', 'delta'],
      'keys() gathered the full keyspace across shards',
    );
    a.stop();
    b.stop();
  });

  test('an owner going down frees its keys at the coordinator', async (assert) => {
    const hub = Node.memoryHub();
    const coord = Node.start('coord@sr', hub.transport());
    const a = Node.start('a@sr', hub.transport());
    const b = Node.start('b@sr', hub.transport());
    const only = () => ['coord@sr'];
    shardedRegistry(coord, { peers: only });
    const regA = shardedRegistry(a, { peers: only });
    const regB = shardedRegistry(b, { peers: only });
    await settle();

    await regA.register('svc', 'leader');
    a.stop(); // the owner dies
    await settle();
    assert.equal(await regB.whereis('svc', 'leader'), null, "the dead owner's key is freed");
    assert.deepEqual(
      await regB.register('svc', 'leader'),
      { ok: true },
      'and claimable by a survivor',
    );
    coord.stop();
    b.stop();
  });

  test('a key re-homes when its coordinator moves; a churn race fires onConflict on the loser', async (assert) => {
    const hub = Node.memoryHub();
    const c1 = Node.start('c1@sr', hub.transport());
    const c2 = Node.start('c2@sr', hub.transport());
    const a = Node.start('a@sr', hub.transport());
    const b = Node.start('b@sr', hub.transport());
    // Controllable rosters: a starts homed on c1; b is ALWAYS homed on c2.
    let rosterA = ['c1@sr'];
    shardedRegistry(c1, { peers: () => ['c1@sr'] });
    const regC2 = shardedRegistry(c2, { peers: () => ['c2@sr'] });
    const regA = shardedRegistry(a, { peers: () => rosterA });
    const regB = shardedRegistry(b, { peers: () => ['c2@sr'] });
    await settle();

    let conflicted = 0;
    assert.deepEqual(
      await regA.register('svc', 'leader', () => void conflicted++),
      { ok: true },
      'a owns the key at c1',
    );
    assert.deepEqual(
      await regB.register('svc', 'leader'),
      { ok: true },
      'b owns the SAME key at c2 (disjoint shards — the churn hazard)',
    );

    // The "coordinator moved" churn: a's roster now points at c2; a new node joining fires
    // nodeup everywhere, which triggers a's re-home — where it collides with b's claim.
    rosterA = ['c2@sr'];
    const noise = Node.start('noise@sr', hub.transport());
    await settle(150);

    assert.equal(
      conflicted,
      1,
      "a's re-home lost the race and its onConflict fired (loser tears down)",
    );
    assert.equal(
      await regC2.whereis('svc', 'leader'),
      'b@sr',
      'exactly one owner survives the churn',
    );
    for (const n of [c1, c2, a, b, noise]) n.stop();
  });
});
