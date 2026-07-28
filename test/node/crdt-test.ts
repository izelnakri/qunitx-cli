import { module, test } from 'qunitx';
import { ORSet } from '../../lib/node/crdt.ts';

// Sync two sets both directions until converged — the anti-entropy step, done by hand.
function sync(a: ORSet, b: ORSet) {
  b.merge(a.state());
  a.merge(b.state());
}

module('Node | ORSet CRDT', { concurrency: true }, () => {
  test('concurrent adds converge regardless of order', (assert) => {
    const a = new ORSet('a@n');
    const b = new ORSet('b@n');
    a.add('x');
    b.add('y');
    sync(a, b);
    assert.deepEqual(a.values().sort(), ['x', 'y']);
    assert.deepEqual(b.values().sort(), ['x', 'y'], 'both nodes agree');
  });

  test('observed-remove: a concurrent add SURVIVES a stale remove (add-wins)', (assert) => {
    const a = new ORSet('a@n');
    const b = new ORSet('b@n');
    a.add('room');
    sync(a, b); // both know 'room'
    // Concurrently: a removes it, b re-adds it (a fresh dot a never saw).
    a.remove('room');
    b.add('room');
    sync(a, b);
    assert.true(a.has('room'), 'the concurrent re-add wins over the stale remove');
    assert.true(b.has('room'), 'both converge to present');
  });

  test('a remove of everything it observed converges to absent', (assert) => {
    const a = new ORSet('a@n');
    const b = new ORSet('b@n');
    a.add('k');
    sync(a, b);
    a.remove('k');
    sync(a, b);
    assert.false(a.has('k'));
    assert.false(b.has('k'), 'both converge to removed');
  });

  test('lost delta then anti-entropy converges (frame loss self-heals)', (assert) => {
    const a = new ORSet('a@n');
    const b = new ORSet('b@n');
    a.add('first');
    // Simulate a DROPPED update: b never received a's first add.
    a.add('second');
    // Later anti-entropy: b merges a's full state and recovers everything.
    b.merge(a.state());
    assert.deepEqual(b.values().sort(), ['first', 'second'], 'anti-entropy recovered the lost add');
  });

  test('dominates skips a no-op sync (VV-gated anti-entropy)', (assert) => {
    const a = new ORSet('a@n');
    a.add('one');
    const b = new ORSet('b@n');
    b.merge(a.state()); // b now has 'one'
    a.add('two');
    assert.false(b.dominates(a.versionVector()), 'b is behind → a sync is worthwhile');
    b.merge(a.state());
    assert.true(b.dominates(a.versionVector()), 'now up to date → next sync is a no-op');
  });

  test('merge is idempotent — applying the same delta twice is a no-op', (assert) => {
    const a = new ORSet('a@n');
    a.add('x');
    const b = new ORSet('b@n');
    const st = a.state();
    b.merge(st);
    b.merge(st); // again
    assert.deepEqual(b.values(), ['x']);
  });

  test('three-way convergence in any pairwise order', (assert) => {
    const a = new ORSet('a@n');
    const b = new ORSet('b@n');
    const c = new ORSet('c@n');
    a.add('a1');
    b.add('b1');
    c.add('c1');
    b.remove('b1'); // b removes its own before anyone saw it
    sync(a, b);
    sync(b, c);
    sync(a, c);
    sync(a, b);
    const expected = ['a1', 'c1'];
    assert.deepEqual(a.values().sort(), expected);
    assert.deepEqual(b.values().sort(), expected);
    assert.deepEqual(c.values().sort(), expected, 'all three converge');
  });
});
