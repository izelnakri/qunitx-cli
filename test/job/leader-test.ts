import { module, test } from 'qunitx';
import { memoryStore, Node, memoryHub } from '../../lib/node/index.ts';
import { Job, leader, raftStore } from '../../lib/job/index.ts';

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (cond: () => boolean, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await settle(15);
  }
  return cond();
};

module('Jobs | leader (Oban.Peer — store lease)', () => {
  test('exactly one candidate holds the lease', async (assert) => {
    const store = memoryStore(); // ONE shared store — the candidates contend for the same lease
    const candidates = ['a', 'b', 'c'].map((candidate) =>
      leader({ store, key: 'jobs:cron', candidate, leaseMs: 300 }),
    );
    await settle(30); // let the first renew land
    assert.equal(
      candidates.filter((holder) => holder.isLeader()).length,
      1,
      'exactly one leads, cluster-wide',
    );
    candidates.forEach((holder) => holder.stop());
  });

  test('a survivor takes leadership after the holder stops and the lease expires', async (assert) => {
    const store = memoryStore();
    const leaderA = leader({ store, key: 'k', candidate: 'a', leaseMs: 150 });
    const leaderB = leader({ store, key: 'k', candidate: 'b', leaseMs: 150 });
    await settle(30);
    const held = leaderA.isLeader() ? leaderA : leaderB;
    const other = held === leaderA ? leaderB : leaderA;
    assert.true(held.isLeader() && !other.isLeader(), 'one leads, the other does not');

    held.stop(); // the leader "crashes" — stops renewing
    await settle(250); // the 150ms lease expires; the survivor renews and takes over
    assert.true(other.isLeader(), 'the survivor took leadership after the lease expired');
    leaderA.stop();
    leaderB.stop();
  });

  test('leader() throws on a store without lease() — never silently disables cron', (assert) => {
    const noLease = {
      load: () => Promise.resolve(undefined),
      save: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    };
    assert.throws(
      () => leader({ store: noLease, key: 'k', candidate: 'a' }),
      /lease\(\)/,
      'a store that cannot coordinate leadership fails loudly at wiring, not silently at cron',
    );
  });

  test('a graceful stop releases the lease so failover is immediate, not after leaseMs', async (assert) => {
    const store = memoryStore();
    const leaderA = leader({ store, key: 'k', candidate: 'a', leaseMs: 1000 });
    const leaderB = leader({ store, key: 'k', candidate: 'b', leaseMs: 1000 });
    await settle(30);
    const held = leaderA.isLeader() ? leaderA : leaderB;
    const other = held === leaderA ? leaderB : leaderA;
    assert.true(held.isLeader(), 'one leads');

    held.stop(); // GRACEFUL stop — releases the lease immediately (not just stops renewing)
    await settle(450); // well under the 1000ms lease — only an immediate release lets `other` take over
    assert.true(
      other.isLeader(),
      'the survivor took over without waiting out the lease — no rolling-deploy gap',
    );
    leaderA.stop();
    leaderB.stop();
  });

  test('cron fires cluster-once: two nodes, a shared leader key, one enqueue', async (assert) => {
    const store = memoryStore(); // shared store: distributed draining + the lease live together
    const fixedMinute = Date.parse('2020-06-01T00:00:00Z'); // a fixed UTC minute — cron '* * * * *' matches
    let ran = 0;

    const make = (candidate: string) => {
      const lead = leader({ store, key: 'jobs:cron', candidate, leaseMs: 500 });
      const queue = Job.queue({
        store,
        leader: lead,
        cron: { '* * * * *': { worker: 'beat' } },
        workers: { beat: () => void (ran += 1) },
        now: () => fixedMinute, // deterministic: same minute every tick, so cron fires at most once/instance
        pollMs: 10,
      });
      return { lead, queue };
    };
    const one = make('one@c');
    const two = make('two@c');
    await settle(40); // elect a leader before cron can fire

    await settle(120); // let ticks run: only the leaseholder enqueues the beat; both may drain it
    await Promise.all([one.queue.drain(), two.queue.drain()]);
    assert.equal(ran, 1, 'the schedule enqueued and ran exactly once across the cluster');

    one.queue.stop();
    two.queue.stop();
    one.lead.stop();
    two.lead.stop();
  });

  test('leader() on a raftStore tracks the CP Raft leader — no TTL, no clock-skew split-brain', async (assert) => {
    const hub = memoryHub();
    const nodeA = Node.start('a@ld', hub.transport());
    const nodeB = Node.start('b@ld', hub.transport());
    const opts = {
      peers: ['a@ld', 'b@ld'],
      heartbeatMs: 15,
      electionTimeoutMs: () => 60 + Math.random() * 60,
    };
    const storeA = raftStore(nodeA, opts);
    const storeB = raftStore(nodeB, opts);
    try {
      assert.true(
        await until(
          () => storeA.raft.leader() !== null && storeA.raft.leader() === storeB.raft.leader(),
        ),
        'the Raft group elected a leader',
      );
      // No lease() renewal — leadership IS the node's raft role; key/candidate are ignored for raft.
      const leaderA = leader({ store: storeA, key: 'jobs:cron', candidate: 'a@ld' });
      const leaderB = leader({ store: storeB, key: 'jobs:cron', candidate: 'b@ld' });
      const raftLeader = storeA.raft.leader();
      assert.equal(leaderA.isLeader(), raftLeader === 'a@ld', 'leaderA follows the raft role');
      assert.equal(leaderB.isLeader(), raftLeader === 'b@ld', 'leaderB follows the raft role');
      assert.true(
        leaderA.isLeader() !== leaderB.isLeader(),
        'exactly one leads — the CP Raft leader, no wall-clock lease',
      );
      leaderA.stop();
      leaderB.stop();
    } finally {
      storeA.stop();
      storeB.stop();
      nodeA.stop();
      nodeB.stop();
    }
  });
});
