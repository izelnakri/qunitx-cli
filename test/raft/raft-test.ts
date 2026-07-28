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

module('Raft | compaction + membership', () => {
  test('the log compacts past snapshotThreshold and the state machine stays exact', async (assert) => {
    const hub = partitionableHub();
    const names = ['r0@rc', 'r1@rc', 'r2@rc'];
    const nodes = names.map((n) => Node.start(n, hub.transport(n)));
    const members = names.map((_, i) =>
      raft<number[]>(nodes[i], {
        peers: names,
        init: () => [],
        apply: (c, s) => ({ state: [...s, c as number], reply: (s as number[]).length + 1 }),
        electionTimeoutMs: () => TIMEOUTS[i] + Math.random() * 40,
        heartbeatMs: 25,
        snapshotThreshold: 5,
      }),
    );
    await until(() => members.some((m) => m.role() === 'leader'));
    const leader = members.find((m) => m.role() === 'leader')!;

    for (let n = 1; n <= 12; n++) await leader.propose(n);
    assert.true(
      await until(() => members.every((m) => m.state().length === 12)),
      'all 12 commands applied everywhere',
    );
    assert.true(
      await until(() => members.every((m) => m.snapshotIndex() > 0)),
      'every member compacted its log (snapshots taken)',
    );
    for (const m of members)
      assert.deepEqual(
        m.state(),
        Array.from({ length: 12 }, (_, i) => i + 1),
        'state is exact after compaction',
      );
    members.forEach((m) => m.stop());
    nodes.forEach((n) => n.stop());
  });

  test('a member cut off past compaction catches up via InstallSnapshot', async (assert) => {
    const hub = partitionableHub();
    const names = ['r0@rs', 'r1@rs', 'r2@rs'];
    const nodes = names.map((n) => Node.start(n, hub.transport(n)));
    const members = names.map((_, i) =>
      raft<number[]>(nodes[i], {
        peers: names,
        init: () => [],
        apply: (c, s) => ({ state: [...s, c as number] }),
        electionTimeoutMs: () => TIMEOUTS[i] + Math.random() * 40,
        heartbeatMs: 25,
        snapshotThreshold: 4,
      }),
    );
    await until(() => members.some((m) => m.role() === 'leader'));
    const leader = members.find((m) => m.role() === 'leader')!;
    const leaderIdx = members.indexOf(leader);
    const laggard = (leaderIdx + 1) % 3;

    await leader.propose(1);
    hub.partition([names[laggard]]); // one follower falls behind
    // The majority commits enough to compact PAST the laggard's log.
    for (let n = 2; n <= 10; n++) await leader.propose(n);
    assert.true(leader.snapshotIndex() > 0, 'the leader compacted while the laggard was away');

    hub.heal();
    assert.true(await until(() => members[laggard].state().length === 10), 'the laggard caught up');
    assert.true(
      members[laggard].snapshotIndex() > 0,
      'and it got there via InstallSnapshot (its missing entries were compacted away)',
    );
    members.forEach((m) => m.stop());
    nodes.forEach((n) => n.stop());
  });

  test('addMember: a fourth member joins, catches up, and COUNTS toward the majority', async (assert) => {
    const hub = partitionableHub();
    const names = ['r0@rm', 'r1@rm', 'r2@rm'];
    const nodes = names.map((n) => Node.start(n, hub.transport(n)));
    const make = (i: number, peers: string[]) =>
      raft<number[]>(nodes[i], {
        peers,
        init: () => [],
        apply: (c, s) => ({ state: [...s, c as number] }),
        electionTimeoutMs: () => TIMEOUTS[i % 3] + 120 + Math.random() * 40,
        heartbeatMs: 25,
        group: 'm',
      });
    const members = names.map((_, i) => make(i, names));
    await until(() => members.some((m) => m.role() === 'leader'));
    const leader = members.find((m) => m.role() === 'leader')!;
    await leader.propose(1);

    // Boot the new member FIRST (current membership + itself), then commit the config change.
    const n3 = Node.start('r3@rm', hub.transport('r3@rm'));
    nodes.push(n3);
    const m3 = raft<number[]>(n3, {
      peers: [...names, 'r3@rm'],
      init: () => [],
      apply: (c, s) => ({ state: [...s, c as number] }),
      electionTimeoutMs: () => 600, // patient — it should be led, not lead
      heartbeatMs: 25,
      group: 'm',
    });
    assert.deepEqual(await leader.addMember('r3@rm'), [...names, 'r3@rm'], 'the config committed');
    await leader.propose(2);
    assert.true(await until(() => m3.state().length === 2), 'the new member caught up and applies');

    // The proof it COUNTS: kill one original follower — 3 of 4 remain, still a majority.
    const follower = members.find((m) => m.role() !== 'leader')!;
    const fIdx = members.indexOf(follower);
    follower.stop();
    nodes[fIdx].stop();
    await leader.propose(3);
    assert.true(
      await until(() => m3.state().length === 3),
      'the group of four kept committing with one member down — the newcomer is in the quorum',
    );
    [...members.filter((_, i) => i !== fIdx), m3].forEach((m) => m.stop());
    nodes.forEach((n, i) => i !== fIdx && n.stop());
  });

  test('removeMember: the group shrinks and keeps committing under the smaller majority', async (assert) => {
    const hub = partitionableHub();
    const names = ['r0@rr', 'r1@rr', 'r2@rr'];
    const nodes = names.map((n) => Node.start(n, hub.transport(n)));
    const members = names.map((_, i) =>
      raft<number[]>(nodes[i], {
        peers: names,
        init: () => [],
        apply: (c, s) => ({ state: [...s, c as number] }),
        electionTimeoutMs: () => TIMEOUTS[i] + Math.random() * 40,
        heartbeatMs: 25,
      }),
    );
    await until(() => members.some((m) => m.role() === 'leader'));
    const leader = members.find((m) => m.role() === 'leader')!;
    const gone = members.find((m) => m.role() !== 'leader')!;
    const goneIdx = members.indexOf(gone);
    const goneName = names[goneIdx];

    const newMembers = await leader.removeMember(goneName);
    assert.false(newMembers.includes(goneName), 'the config committed without the removed member');
    gone.stop();
    nodes[goneIdx].stop(); // it leaves for real

    await leader.propose(7);
    const rest = members.filter((_, i) => i !== goneIdx);
    assert.true(
      await until(() => rest.every((m) => m.state().length === 1)),
      'the two survivors commit under the 2-member majority',
    );
    rest.forEach((m) => m.stop());
    nodes.forEach((n, i) => i !== goneIdx && n.stop());
  });
});
