import { module, test } from 'qunitx';
import { rendezvous } from '../../lib/node/rendezvous.ts';

module('Node | rendezvous hashing', { concurrency: true }, () => {
  test('deterministic and cluster-agreed for a given node set', (assert) => {
    const nodes = ['a@n', 'b@n', 'c@n', 'd@n'];
    const owner = rendezvous('room:lobby', nodes);
    assert.true(nodes.includes(owner!));
    assert.strictEqual(rendezvous('room:lobby', nodes), owner, 'same answer every time');
    assert.strictEqual(rendezvous('room:lobby', [...nodes].reverse()), owner, 'order-independent');
  });

  test('empty node set is null', (assert) => {
    assert.strictEqual(rendezvous('x', []), null);
  });

  test('spreads keys across the cluster', (assert) => {
    const nodes = ['a@n', 'b@n', 'c@n'];
    const counts: Record<string, number> = { 'a@n': 0, 'b@n': 0, 'c@n': 0 };
    for (let i = 0; i < 3000; i++) counts[rendezvous(`k${i}`, nodes)!] += 1;
    for (const node of nodes)
      assert.true(counts[node] > 700, `${node} got a fair share (${counts[node]})`);
  });

  test('removing a node moves ONLY its keys — the minimal-movement property', (assert) => {
    const full = ['a@n', 'b@n', 'c@n', 'd@n'];
    const reduced = ['a@n', 'b@n', 'c@n']; // d@n left
    let moved = 0;
    let ownedByD = 0;
    const keys = Array.from({ length: 4000 }, (_, i) => `room:${i}`);
    for (const key of keys) {
      const before = rendezvous(key, full)!;
      const after = rendezvous(key, reduced)!;
      if (before === 'd@n') ownedByD += 1;
      if (before !== after) moved += 1;
    }
    // Every moved key was one d@n owned; keys d@n never owned did NOT move (unlike modulo).
    assert.strictEqual(moved, ownedByD, 'exactly d@n’s keys relocated, nothing else');
    assert.true(moved < keys.length / 3, `only ~1/N moved (${moved}/${keys.length})`);
  });
});
