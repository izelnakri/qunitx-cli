import { module, test } from 'qunitx';
import { memoryStore } from '../../lib/node/index.ts';
import { jobQueue, leader } from '../../lib/jobs/index.ts';

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

module('Jobs | leader (Oban.Peer — store lease)', () => {
  test('exactly one candidate holds the lease', async (assert) => {
    const store = memoryStore();
    const cands = ['a', 'b', 'c'].map((c) =>
      leader({ store, key: 'jobs:cron', candidate: c, leaseMs: 300 }),
    );
    await settle(30); // let the first renew land
    assert.equal(cands.filter((l) => l.isLeader()).length, 1, 'exactly one leads, cluster-wide');
    cands.forEach((l) => l.stop());
  });

  test('a survivor takes leadership after the holder stops and the lease expires', async (assert) => {
    const store = memoryStore();
    const a = leader({ store, key: 'k', candidate: 'a', leaseMs: 150 });
    const b = leader({ store, key: 'k', candidate: 'b', leaseMs: 150 });
    await settle(30);
    const held = a.isLeader() ? a : b;
    const other = held === a ? b : a;
    assert.true(held.isLeader() && !other.isLeader(), 'one leads, the other does not');

    held.stop(); // the leader "crashes" — stops renewing
    await settle(250); // the 150ms lease expires; the survivor renews and takes over
    assert.true(other.isLeader(), 'the survivor took leadership after the lease expired');
    a.stop();
    b.stop();
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
    const a = leader({ store, key: 'k', candidate: 'a', leaseMs: 1000 });
    const b = leader({ store, key: 'k', candidate: 'b', leaseMs: 1000 });
    await settle(30);
    const held = a.isLeader() ? a : b;
    const other = held === a ? b : a;
    assert.true(held.isLeader(), 'one leads');

    held.stop(); // GRACEFUL stop — releases the lease immediately (not just stops renewing)
    await settle(450); // well under the 1000ms lease — only an immediate release lets `other` take over
    assert.true(
      other.isLeader(),
      'the survivor took over without waiting out the lease — no rolling-deploy gap',
    );
    a.stop();
    b.stop();
  });

  test('cron fires cluster-once: two nodes, a shared leader key, one enqueue', async (assert) => {
    const store = memoryStore(); // shared store: distributed draining + the lease live together
    const AT = Date.parse('2020-06-01T00:00:00Z'); // a fixed UTC minute — cron '* * * * *' matches
    let ran = 0;

    const make = (candidate: string) => {
      const lead = leader({ store, key: 'jobs:cron', candidate, leaseMs: 500 });
      const jobs = jobQueue({
        store,
        leader: lead,
        cron: { '* * * * *': { worker: 'beat' } },
        workers: { beat: () => void (ran += 1) },
        now: () => AT, // deterministic: same minute every tick, so cron fires at most once/instance
        pollMs: 10,
      });
      return { lead, jobs };
    };
    const one = make('one@c');
    const two = make('two@c');
    await settle(40); // elect a leader before cron can fire

    await settle(120); // let ticks run: only the leaseholder enqueues the beat; both may drain it
    await Promise.all([one.jobs.drain(), two.jobs.drain()]);
    assert.equal(ran, 1, 'the schedule enqueued and ran exactly once across the cluster');

    one.jobs.stop();
    two.jobs.stop();
    one.lead.stop();
    two.lead.stop();
  });
});
