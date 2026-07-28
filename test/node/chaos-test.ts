import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';

// A chaos hub: drops a fraction of every node's outbound frames (packet loss), so ONLY the
// CRDT + anti-entropy can bring the cluster to agreement. This is the proof the audit asked
// for — resilience demonstrated, not asserted.
function chaosHub(dropRate: number) {
  const inner = Node.memoryHub();
  let drops = 0;
  // A deterministic pseudo-random gate (no Math.random — keeps the test reproducible).
  let seed = 0x2545f491;
  const roll = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return {
    transport() {
      const t = inner.transport();
      return {
        send(f: Node.Frame) {
          // Never drop hellos/byes/sync (control) — loss there just delays discovery; drop the
          // data-plane deltas + full pushes to stress convergence.
          if ((f.kind === 'crdt' || f.kind === 'reply') && roll() < dropRate) return void drops++;
          t.send(f);
        },
        onFrame: (h: (f: Node.Frame) => void) => t.onFrame(h),
        close: t.close,
      };
    },
    drops: () => drops,
  };
}

module('Node | chaos convergence', () => {
  test('under 40% frame loss the whole cluster converges (registry + groups)', async (assert) => {
    const hub = chaosHub(0.4);
    const nodes = ['a', 'b', 'c', 'd'].map((n) =>
      Node.start(`${n}@chaos`, hub.transport(), { antiEntropyMs: 15, tick: false }),
    );
    await new Promise((r) => setTimeout(r, 40)); // hellos

    // Every node registers a distinct set of keys and joins groups, amid the loss.
    nodes[0].register('rooms', 'lobby');
    nodes[1].register('rooms', 'random');
    nodes[2].register('rooms', 'games');
    nodes[3].register('rooms', 'lobby'); // a conflict with node 0 — smaller name (a@chaos) wins
    for (const n of nodes) n.join('workers');
    nodes[0].join('admins');

    // Give anti-entropy time to reconcile everything despite the drops.
    const until = async (cond: () => boolean, ms = 4000) => {
      const deadline = Date.now() + ms;
      while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
      return cond();
    };
    const converged = () =>
      nodes.every(
        (n) =>
          n.whereis('rooms', 'lobby') === 'a@chaos' &&
          n.whereis('rooms', 'random') === 'b@chaos' &&
          n.whereis('rooms', 'games') === 'c@chaos' &&
          n.groupMembers('workers').length === 4 &&
          n.groupMembers('admins').length === 1,
      );
    assert.true(await until(converged), 'all four nodes agree on registry + groups');
    assert.true(hub.drops() > 0, `frames were actually dropped (${hub.drops()})`);
    for (const n of nodes) n.stop();
  });
});
