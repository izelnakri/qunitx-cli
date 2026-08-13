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

module('Node | weighted rendezvous', { concurrency: true }, () => {
  const nodes = ['a@n', 'b@n', 'c@n', 'd@n'];

  test('a weightOf that is uniform matches unweighted placement per key', (assert) => {
    // Equal weights → the score ordering is the raw hash order, so ownership is unchanged.
    let same = 0;
    for (let i = 0; i < 200; i++) {
      const key = `k${i}`;
      if (rendezvous(key, nodes) === rendezvous(key, nodes, () => 1)) same++;
    }
    assert.equal(same, 200, 'uniform weights are equivalent to unweighted');
  });

  test("a node's share of the keyspace scales with its weight", (assert) => {
    // 'a@n' weighted 5x the others should own roughly 5/(5+1+1+1) ~= 62% of keys.
    const weight: Record<string, number> = { 'a@n': 5, 'b@n': 1, 'c@n': 1, 'd@n': 1 };
    const counts: Record<string, number> = {};
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const owner = rendezvous(`key:${i}`, nodes, (n) => weight[n])!;
      counts[owner] = (counts[owner] ?? 0) + 1;
    }
    const share = counts['a@n'] / N;
    assert.true(
      share > 0.5 && share < 0.75,
      `heavy node owns ~5/8 of keys (got ${share.toFixed(2)})`,
    );
    assert.true((counts['b@n'] ?? 0) > 0, 'light nodes still own some');
  });

  test('weight 0 opts a node out entirely', (assert) => {
    const drained = 'a@n';
    for (let i = 0; i < 500; i++) {
      const owner = rendezvous(`x${i}`, nodes, (n) => (n === drained ? 0 : 1));
      assert.notEqual(owner, drained, `${drained} owns nothing when weighted 0`);
    }
    // Draining a node is a clean way to evacuate it before shutdown.
    assert.equal(
      rendezvous('only', ['solo@n'], () => 0),
      null,
      'all-zero weights → no owner',
    );
  });

  test('determinism: same key + weights → same owner on every caller', (assert) => {
    const weight: Record<string, number> = { 'a@n': 3, 'b@n': 2, 'c@n': 1, 'd@n': 1 };
    const first = rendezvous('stable', nodes, (n) => weight[n]);
    for (let i = 0; i < 50; i++)
      assert.equal(
        rendezvous('stable', nodes, (n) => weight[n]),
        first,
        'stable placement',
      );
  });
});
