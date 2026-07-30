import { module, test } from 'qunitx';
import { start, memoryHub } from '../../lib/node/index.ts';
import { jobQueue, raftStore } from '../../lib/jobs/index.ts';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (cond: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await pause(15);
  }
  return cond();
};

module('Jobs | raftStore (external-DB-free distributed store)', () => {
  test('two nodes drain ONE Raft-backed store: work splits, nothing runs twice', async (assert) => {
    const hub = memoryHub();
    const nodeA = start('a@rs', hub.transport());
    const nodeB = start('b@rs', hub.transport());
    const opts = {
      peers: ['a@rs', 'b@rs'],
      heartbeatMs: 15,
      electionTimeoutMs: () => 60 + Math.random() * 60,
    };
    const storeA = raftStore(nodeA, opts);
    const storeB = raftStore(nodeB, opts);
    // wait for the Raft group to elect a leader (both members agree on one)
    assert.true(
      await until(
        () => storeA.raft.leader() !== null && storeA.raft.leader() === storeB.raft.leader(),
      ),
      'the Raft group elected a leader',
    );

    const runByNode: Record<string, string> = {}; // jobId -> node, or 'DUP' if two ran it
    const makeQueue = (store: typeof storeA, tag: string) =>
      jobQueue({
        store,
        pollMs: 20,
        queues: { default: 2 }, // each node runs at most 2 at once — neither can take all 8
        workers: {
          work: async (args) => {
            const jobId = (args as { id: string }).id;
            runByNode[jobId] = runByNode[jobId] ? 'DUP' : tag;
            await pause(25);
          },
        },
      });
    const queueA = makeQueue(storeA, 'A');
    const queueB = makeQueue(storeB, 'B');
    for (let index = 0; index < 8; index += 1) await queueA.insert('work', { id: `j${index}` });

    await Promise.all([queueA.drain(), queueB.drain()]); // both drain concurrently, coordinated only by Raft
    const outcomes = Object.values(runByNode);
    assert.equal(Object.keys(runByNode).length, 8, 'every job ran exactly once');
    assert.equal(
      outcomes.filter((tag) => tag === 'DUP').length,
      0,
      'no job ran twice — the Raft-committed claim is atomic, no external DB',
    );
    assert.true(
      outcomes.includes('A') && outcomes.includes('B'),
      'both nodes drained a share — the claim partitioned the work',
    );

    queueA.stop();
    queueB.stop();
    storeA.stop();
    storeB.stop();
    nodeA.stop();
    nodeB.stop();
  });
});
