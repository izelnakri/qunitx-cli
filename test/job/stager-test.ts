import { module, test } from 'qunitx';
import { Node, memoryHub, memoryStore } from '../../lib/node/index.ts';
import { Job, raftStore } from '../../lib/job/index.ts';

const until = async (cond: () => boolean, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return cond();
};

// A job a now-dead node left `executing` (its attemptedAt is in the past).
const orphan = (id: string, attemptedAt: number, over = false) => ({
  id,
  worker: 'work',
  args: { id },
  queue: 'default',
  state: 'executing',
  attempt: over ? 3 : 1,
  maxAttempts: 3,
  priority: 0,
  scheduledAt: 0,
  attemptedAt,
  errors: [],
});

module('Jobs | stager (Oban rescuer — reclaim jobs orphaned mid-run)', () => {
  test('reclaims a job stuck executing past the timeout and a survivor re-runs it', async (assert) => {
    const store = memoryStore();
    const ran: string[] = [];
    await store.save('jobs:orphan', orphan('orphan', Date.now() - 10_000));
    const queue = Job.queue({
      store,
      pollMs: 10,
      reclaimAfterMs: 50, // executing longer than 50ms → the owner is presumed dead
      workers: { work: (args) => void ran.push((args as { id: string }).id) },
    });
    assert.true(
      await until(() => ran.includes('orphan')),
      'the orphaned job was reclaimed and re-run',
    );
    assert.equal(
      await store.load('jobs:orphan'),
      undefined,
      'the reclaimed job completed and was removed from the store',
    );
    queue.stop();
  });

  test('an orphan already out of attempts is discarded, not re-run', async (assert) => {
    const store = memoryStore();
    const ran: string[] = [];
    await store.save('jobs:dead', orphan('dead', Date.now() - 10_000, true)); // attempt 3 / maxAttempts 3
    const queue = Job.queue({
      store,
      pollMs: 10,
      reclaimAfterMs: 50,
      workers: { work: (args) => void ran.push((args as { id: string }).id) },
    });
    await new Promise((resolve) => setTimeout(resolve, 150)); // let the stager pass run
    assert.deepEqual(ran, [], 'an exhausted orphan is dead-lettered, never re-run');
    assert.equal(
      ((await store.load('jobs:dead')) as { state: string }).state,
      'discarded',
      'kept as discarded — the durable dead-letter record in the STORE',
    );
    // The rescue is a store-level fact. This queue never had `dead` in its own index (it was seeded
    // straight into the store, as a dead node would leave it), so the app-facing `peekAll()` — which
    // reads THIS instance's in-memory view — can't see it. `store.load` is the durable truth;
    // `peekAll({ state: 'discarded' })` is per-instance. (An inserted-then-failed job IS in peekAll()
    // — see the dead-letter routing test.)
    assert.equal(
      queue.peekAll({ state: 'discarded' }).length,
      0,
      'the app-level peekAll() reflects only this instance — a store-seeded reclaim is not in its view',
    );
    queue.stop();
  });

  test('reclaims through raftStore — the rescue is a committed Raft command', async (assert) => {
    const hub = memoryHub();
    const node = Node.start('n@st', hub.transport());
    const store = raftStore(node, { peers: ['n@st'], electionTimeoutMs: () => 15 });
    const ran: string[] = [];
    try {
      assert.true(
        await until(() => store.raft.leader() !== null),
        'the single-member group elected',
      );
      await store.save('jobs:orphan', orphan('orphan', Date.now() - 10_000));
      const queue = Job.queue({
        store,
        pollMs: 15,
        reclaimAfterMs: 50,
        workers: { work: (args) => void ran.push((args as { id: string }).id) },
      });
      assert.true(
        await until(() => ran.includes('orphan')),
        'the raftStore stager reclaimed and re-ran it',
      );
      queue.stop();
    } finally {
      store.stop();
      node.stop();
    }
  });
});
