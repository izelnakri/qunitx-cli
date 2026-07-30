import { module, test } from 'qunitx';
import { start, memoryHub, memoryStore } from '../../lib/node/index.ts';
import { jobQueue, raftStore } from '../../lib/jobs/index.ts';

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
    const jobs = jobQueue({
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
    jobs.stop();
  });

  test('an orphan already out of attempts is discarded, not re-run', async (assert) => {
    const store = memoryStore();
    const ran: string[] = [];
    await store.save('jobs:dead', orphan('dead', Date.now() - 10_000, true)); // attempt 3 / maxAttempts 3
    const jobs = jobQueue({
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
      'kept as discarded',
    );
    jobs.stop();
  });

  test('reclaims through raftStore — the rescue is a committed Raft command', async (assert) => {
    const hub = memoryHub();
    const node = start('n@st', hub.transport());
    const store = raftStore(node, { peers: ['n@st'], electionTimeoutMs: () => 15 });
    const ran: string[] = [];
    try {
      assert.true(
        await until(() => store.raft.leader() !== null),
        'the single-member group elected',
      );
      await store.save('jobs:orphan', orphan('orphan', Date.now() - 10_000));
      const jobs = jobQueue({
        store,
        pollMs: 15,
        reclaimAfterMs: 50,
        workers: { work: (args) => void ran.push((args as { id: string }).id) },
      });
      assert.true(
        await until(() => ran.includes('orphan')),
        'the raftStore stager reclaimed and re-ran it',
      );
      jobs.stop();
    } finally {
      store.stop();
      node.stop();
    }
  });
});
