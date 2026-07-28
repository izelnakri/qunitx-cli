import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { raft, type Raft } from '../../lib/raft/index.ts';
import { isFailure, type Any as AnyFailure } from '../../lib/result/failure.ts';

const until = async (cond: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
  return cond();
};

// A hub whose links can be partitioned: frames between separated groups are dropped, both ways.
function partitionableHub() {
  const inner = Node.memoryHub();
  let separated: Set<string> | null = null; // the isolated minority, by node name
  const split = (frame: Node.Frame, owner: string): boolean => {
    if (!separated) return false;
    const fromIsolated = separated.has(frame.from);
    const ownerIsolated = separated.has(owner);
    return fromIsolated !== ownerIsolated; // crossing the partition line — drop
  };
  return {
    transport(owner: string): Node.Transport {
      const t = inner.transport();
      return {
        send(frame) {
          if (separated && separated.has(frame.from) !== separated.has(frame.to ?? '')) {
            // Directed frames crossing the line are dropped; broadcasts are filtered on receive.
            if (frame.to !== undefined) return;
          }
          t.send(frame);
        },
        onFrame: (h) =>
          t.onFrame((frame) => {
            if (split(frame, owner)) return; // inbound across the line — dropped
            h(frame);
          }),
        close: t.close,
      };
    },
    partition: (names: string[]) => void (separated = new Set(names)),
    heal: () => void (separated = null),
  };
}

// Deterministic-ish elections: distinct fixed timeouts, so the smallest wins the first race.
const TIMEOUTS = [80, 160, 240];
function cluster(hub: { transport(owner: string): Node.Transport }, names: string[]) {
  const nodes = names.map((n) => Node.start(n, hub.transport(n)));
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
  return { nodes, members };
}

module('Raft | CP consensus', () => {
  test('three members elect exactly one leader', async (assert) => {
    const hub = partitionableHub();
    const { nodes, members } = cluster(hub, ['r0@raft', 'r1@raft', 'r2@raft']);
    assert.true(
      await until(() => members.filter((m) => m.role() === 'leader').length === 1),
      'exactly one leader emerged',
    );
    const leader = members.find((m) => m.role() === 'leader')!;
    assert.true(
      await until(() => members.every((m) => m.leader() === leader.leader())),
      'every member agrees who leads',
    );
    members.forEach((m) => m.stop());
    nodes.forEach((n) => n.stop());
  });

  test('a proposal commits on a majority and applies IN ORDER on every member', async (assert) => {
    const hub = partitionableHub();
    const { nodes, members } = cluster(hub, ['r0@raft', 'r1@raft', 'r2@raft']);
    await until(() => members.some((m) => m.role() === 'leader'));
    const leader = members.find((m) => m.role() === 'leader')!;

    assert.equal(await leader.propose(10), 1, 'the apply reply came back on commit');
    assert.equal(await leader.propose(20), 2, 'sequential proposals commit in order');
    assert.true(
      await until(() => members.every((m) => m.state().length === 2)),
      'followers applied both entries',
    );
    for (const m of members)
      assert.deepEqual(m.state(), [10, 20], `${m.leader()}-view state is identical`);

    // A follower refuses with the leader hint — the caller retries there.
    const follower = members.find((m) => m.role() !== 'leader')!;
    const rejection = await follower.propose(99).then(
      () => null,
      (e) => e,
    );
    assert.true(
      isFailure(rejection) && (rejection as AnyFailure).code === 'NotLeader',
      'a follower rejects with NotLeader',
    );
    assert.equal(
      (rejection as AnyFailure).data && (rejection as { data: { leader: string } }).data.leader,
      leader.leader(),
      'the rejection carries the leader hint',
    );
    members.forEach((m) => m.stop());
    nodes.forEach((n) => n.stop());
  });

  test('the leader dies — a new leader is elected and committed entries survive', async (assert) => {
    const hub = partitionableHub();
    const names = ['r0@raft', 'r1@raft', 'r2@raft'];
    const { nodes, members } = cluster(hub, names);
    await until(() => members.some((m) => m.role() === 'leader'));
    const first = members.findIndex((m) => m.role() === 'leader');

    await members[first].propose(7); // committed on a majority before the crash
    members[first].stop();
    nodes[first].stop();

    const survivors = members.filter((_, i) => i !== first);
    assert.true(
      await until(() => survivors.some((m) => m.role() === 'leader')),
      'a survivor took over',
    );
    const successor = survivors.find((m) => m.role() === 'leader')!;
    assert.deepEqual(successor.state(), [7], 'the committed entry SURVIVED the leader crash');
    await successor.propose(8);
    assert.true(
      await until(() => survivors.every((m) => m.state().length === 2)),
      'the group keeps committing under the new leader',
    );
    survivors.forEach((m) => m.stop());
    nodes.forEach((n, i) => i !== first && n.stop());
  });

  test('CP under partition: a minority CANNOT commit; the majority can; heal converges', async (assert) => {
    const hub = partitionableHub();
    const names = ['r0@raft', 'r1@raft', 'r2@raft'];
    const { nodes, members } = cluster(hub, names);
    await until(() => members.some((m) => m.role() === 'leader'));
    const leaderIdx = members.findIndex((m) => m.role() === 'leader');
    const leader = members[leaderIdx];
    await leader.propose(1); // a committed baseline everyone holds

    // Isolate the LEADER as a minority of one.
    const committedBefore = leader.committedIndex();
    hub.partition([names[leaderIdx]]);
    const minorityAttempt = leader.propose(666).then(
      () => 'committed',
      () => 'rejected',
    );

    // The majority side elects a fresh leader and keeps committing — the minority cannot.
    const majority = members.filter((_, i) => i !== leaderIdx);
    assert.true(
      await until(() => majority.some((m) => m.role() === 'leader')),
      'the majority elected a new leader',
    );
    const newLeader = majority.find((m) => m.role() === 'leader')!;
    await newLeader.propose(2);
    assert.true(
      await until(() => majority.every((m) => m.state().length === 2)),
      'the majority committed while partitioned',
    );
    assert.equal(
      leader.committedIndex(),
      committedBefore,
      "the isolated minority committed NOTHING new — that's CP",
    );

    // Heal: the old leader steps down, truncates its uncommitted entry, and converges.
    hub.heal();
    assert.true(
      await until(() => members.every((m) => m.state().length === 2)),
      'after heal every member holds the majority history',
    );
    for (const m of members)
      assert.deepEqual(m.state(), [1, 2], 'no member ever saw the minority write');
    assert.equal(
      await minorityAttempt,
      'rejected',
      "the minority's proposal was rejected, never silently committed",
    );
    members.forEach((m) => m.stop());
    nodes.forEach((n) => n.stop());
  });
});
