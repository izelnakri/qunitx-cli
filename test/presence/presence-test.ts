import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { presence } from '../../lib/presence/index.ts';
import { pubsub } from '../../lib/pubsub/index.ts';

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

module('Presence | Phoenix.Presence', () => {
  test('track then list shows the entry with its meta', (assert) => {
    const node = Node.start('a@pr', Node.memoryHub().transport());
    const pr = presence(node);
    pr.track('room:lobby', 'ada', { typing: false });
    assert.deepEqual(pr.list('room:lobby'), { ada: { metas: [{ typing: false }] } });
    node.stop();
  });

  test('multiple tracks of one key show as multiple metas (two tabs)', (assert) => {
    const node = Node.start('a@pr', Node.memoryHub().transport());
    const pr = presence(node);
    pr.track('room:1', 'ada', { tab: 1 });
    pr.track('room:1', 'ada', { tab: 2 });
    assert.deepEqual(
      pr.list('room:1').ada.metas.sort((x, y) => (x.tab as number) - (y.tab as number)),
      [{ tab: 1 }, { tab: 2 }],
    );
    node.stop();
  });

  test('untrack removes; update replaces meta', (assert) => {
    const node = Node.start('a@pr', Node.memoryHub().transport());
    const pr = presence(node);
    const off = pr.track('t', 'k', { v: 1 });
    pr.update('t', 'k', { v: 2 });
    assert.deepEqual(pr.list('t'), { k: { metas: [{ v: 2 }] } }, 'meta updated');
    off();
    assert.deepEqual(pr.list('t'), {}, 'untracked');
    node.stop();
  });

  test('a presence tracked on one node converges to another', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@pr', hub.transport());
    const b = Node.start('b@pr', hub.transport());
    presence(a).track('room:x', 'ada', { role: 'host' });
    await settle(); // CRDT gossip

    assert.deepEqual(
      presence(b).list('room:x'),
      { ada: { metas: [{ role: 'host' }] } },
      'b sees a-tracked presence',
    );
    a.stop();
    b.stop();
  });

  test('a node going down HIDES its presences (liveness), not deletes them', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@pr', hub.transport());
    const b = Node.start('b@pr', hub.transport());
    presence(a).track('room:x', 'ada', {});
    presence(b).track('room:x', 'bo', {});
    await settle();
    const prB = presence(b);
    assert.deepEqual(Object.keys(prB.list('room:x')).sort(), ['ada', 'bo'], 'both present');

    a.stop(); // a says bye → b marks a down
    await settle();
    assert.deepEqual(
      Object.keys(prB.list('room:x')),
      ['bo'],
      "a's presence is hidden once it's down",
    );
    b.stop();
  });

  test('presence_diff broadcasts join/leave over PubSub', async (assert) => {
    const node = Node.start('a@pr', Node.memoryHub().transport());
    const bus = pubsub(node);
    const pr = presence(node, bus);
    const diffs: unknown[] = [];
    pr.subscribe('room:1', (diff) => diffs.push(diff));
    await settle();

    const off = pr.track('room:1', 'ada', { x: 1 });
    await settle();
    off();
    await settle();
    assert.deepEqual(diffs, [
      { joins: [{ key: 'ada', meta: { x: 1 } }], leaves: [] },
      { joins: [], leaves: [{ key: 'ada', meta: { x: 1 } }] },
    ]);
    node.stop();
  });
});
