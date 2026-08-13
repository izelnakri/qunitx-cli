import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { shardedRegistry } from '../../lib/node/index.ts';
import { raft, type Raft } from '../../lib/raft/index.ts';

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 6000) => {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
  return cond();
};

// An append-log Raft group: state is the committed command list, reply is its new length — so each
// applied command reports the UNIQUE position it linearized at.
const TIMEOUTS = [80, 160, 240];
const raftCluster = (names: string[]) => {
  const hub = Node.memoryHub();
  const nodes = names.map((n) => Node.start(n, hub.transport()));
  const members: Raft<number[]>[] = names.map((_, i) =>
    raft<number[]>(nodes[i], {
      peers: names,
      init: () => [],
      apply: (command, state) => {
        const next = [...state, command as number];
        return { state: next, reply: next.length };
      },
      electionTimeoutMs: () => TIMEOUTS[i % TIMEOUTS.length] + Math.random() * 40,
      heartbeatMs: 25,
    }),
  );
  return { hub, nodes, members };
};

// Linearizability = every operation appears to take effect atomically at a single point between its
// invocation and response, and every replica agrees on that one order. Chaos tests prove CONVERGENCE;
// these prove the stronger CP guarantee the Raft group and sharded registry claim.
module('CP linearizability | Raft', () => {
  test('concurrent proposals get UNIQUE linearization points — no lost updates', async (assert) => {
    const { nodes, members } = raftCluster(['r0@lin', 'r1@lin', 'r2@lin']);
    await until(() => members.some((m) => m.role() === 'leader'));
    const leader = members.find((m) => m.role() === 'leader')!;

    // Fire N proposals CONCURRENTLY at the leader. If the log is a true total order, each apply sees a
    // distinct prior length, so the replies are exactly the permutation 1..N — none lost, none doubled.
    const N = 30;
    const replies = (await Promise.all(
      Array.from({ length: N }, (_, i) => leader.propose(i)),
    )) as number[];
    assert.deepEqual(
      replies.slice().sort((a, b) => a - b),
      Array.from({ length: N }, (_, i) => i + 1),
      'every proposal linearized at a unique position 1..N',
    );
    assert.true(
      await until(() => members.every((m) => m.state().length === N)),
      'all three replicas converged to the same committed log length',
    );
    const [s0, s1, s2] = members.map((m) => m.state());
    assert.deepEqual(s0, s1, 'replica 0 and 1 hold the identical order');
    assert.deepEqual(s1, s2, 'replica 1 and 2 hold the identical order');

    members.forEach((m) => m.stop());
    nodes.forEach((n) => n.stop());
  });

  test('a committed prefix survives leader failover (committed entries never truncate)', async (assert) => {
    const { nodes, members } = raftCluster(['r0@fo', 'r1@fo', 'r2@fo']);
    await until(() => members.some((m) => m.role() === 'leader'));
    let leader = members.find((m) => m.role() === 'leader')!;

    // Commit a prefix (awaited → majority-durable), then KILL the leader.
    for (let i = 1; i <= 5; i += 1) await leader.propose(i);
    const dead = leader;
    dead.stop();
    const survivors = members.filter((m) => m !== dead);

    // A new leader must emerge among the survivors, and the committed prefix must still be there.
    assert.true(
      await until(() => survivors.some((m) => m.role() === 'leader')),
      'a new leader was elected after the failover',
    );
    leader = survivors.find((m) => m.role() === 'leader')!;
    for (let i = 6; i <= 10; i += 1) await leader.propose(i);

    assert.true(
      await until(() => survivors.every((m) => m.state().length === 10)),
      'survivors committed the post-failover suffix',
    );
    for (const m of survivors)
      assert.deepEqual(
        m.state().slice(0, 5),
        [1, 2, 3, 4, 5],
        'the pre-failover committed prefix was preserved verbatim',
      );

    survivors.forEach((m) => m.stop());
    nodes.forEach((n) => n.stop());
  });
});

module('CP linearizability | sharded registry', () => {
  test('concurrent claims on ONE key yield exactly one winner, agreed by all', async (assert) => {
    const hub = Node.memoryHub();
    const only = () => ['coord@lin']; // pin the key to one coordinator — claims serialize through it
    const coord = Node.start('coord@lin', hub.transport());
    shardedRegistry(coord, { peers: only });
    const N = 8;
    const nodes = Array.from({ length: N }, (_, i) => Node.start(`n${i}@lin`, hub.transport()));
    const regs = nodes.map((n) => shardedRegistry(n, { peers: only }));
    await settle();

    // Everyone races for the same key at once — the coordinator must pick exactly one.
    const results = await Promise.all(regs.map((r) => r.register('rooms', 'lobby')));
    const winners = results.filter((r): r is { ok: true } => 'ok' in r && r.ok);
    const losers = results.filter((r): r is { error: 'taken'; owner: string } => 'error' in r);
    assert.strictEqual(winners.length, 1, 'exactly ONE claim won');
    assert.strictEqual(losers.length, N - 1, 'every other claim was rejected');

    const owners = new Set(losers.map((r) => r.owner));
    assert.strictEqual(owners.size, 1, 'all losers name the SAME owner (one agreed history)');
    const winnerIndex = results.findIndex((r) => 'ok' in r && r.ok);
    assert.strictEqual(
      [...owners][0],
      `n${winnerIndex}@lin`,
      'and that owner is exactly the node whose claim won',
    );

    coord.stop();
    nodes.forEach((n) => n.stop());
  });
});
