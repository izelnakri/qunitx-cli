import { module, test } from 'qunitx';
import { GCounter, PNCounter, LWWMap } from '../../lib/node/index.ts';

module('Node | CRDT counters + LWW map', { concurrency: true }, () => {
  test('GCounter: concurrent increments converge to the total, idempotently', (assert) => {
    const a = new GCounter('a@n');
    const b = new GCounter('b@n');
    a.increment(2);
    b.increment(3);
    a.merge(b.state());
    b.merge(a.state());
    a.merge(b.state()); // re-merge — idempotent
    assert.equal(a.value(), 5);
    assert.equal(b.value(), 5, 'both replicas agree');
    assert.throws(() => a.increment(-1), RangeError, 'a G-counter never shrinks');
  });

  test('PNCounter: a gauge converges across replicas, decrements included', (assert) => {
    const a = new PNCounter('a@n');
    const b = new PNCounter('b@n');
    a.increment(5);
    b.increment(2);
    b.decrement(4);
    a.merge(b.state());
    b.merge(a.state());
    assert.equal(a.value(), 3, '5 + 2 - 4');
    assert.equal(b.value(), 3, 'both agree');
  });

  test('LWWMap: the newest write per key wins everywhere; ties break by replica id', (assert) => {
    const a = new LWWMap<string>('a@n');
    const b = new LWWMap<string>('b@n');
    a.set('theme', 'dark', 100);
    b.set('theme', 'light', 200);
    a.set('flag', 'on', 50);
    b.set('flag', 'off', 50); // exact tie — 'b@n' > 'a@n' wins deterministically
    a.merge(b.state());
    b.merge(a.state());
    assert.equal(a.get('theme'), 'light', 'later timestamp won');
    assert.equal(b.get('theme'), 'light', 'both agree');
    assert.equal(a.get('flag'), 'off', 'tie broken by replica id');
    assert.equal(b.get('flag'), 'off', 'deterministically on both');
    assert.deepEqual(a.keys().sort(), ['flag', 'theme']);
  });

  test('LWWMap: a stale merge cannot regress a newer local write', (assert) => {
    const a = new LWWMap<number>('a@n');
    a.set('limit', 10, 200);
    a.merge({ limit: { value: 5, at: 100, by: 'b@n' } }); // older — ignored
    assert.equal(a.get('limit'), 10, 'the newer write survived the stale merge');
  });
});
