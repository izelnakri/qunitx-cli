import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const US = String.fromCharCode(0x1f);

// The routing lookups (groupMembers / whereis) are backed by a secondary index kept in step with the
// CRDT — so they must return EXACTLY what a brute-force scan of the raw facts would. These tests pin
// that equivalence, including the edge that broke it first: a group name that itself contains U+001F
// (Phoenix.PubSub names groups `pubsub<U+001F><topic>`), where a naive first-separator split mis-parses.
module('Node | routing index (group/registry lookups)', () => {
  test('a group NAME containing the U+001F separator still routes correctly', (assert) => {
    const node = Node.start('a@idx', Node.memoryHub().transport());
    const group = `pubsub${US}room:lobby`; // the exact shape PubSub uses — a separator inside the name
    node.join(group);
    assert.deepEqual(
      node.groupMembers(group),
      ['a@idx'],
      'the member is found under the structured name',
    );
    assert.deepEqual(node.groupMembers('unrelated'), [], 'an unknown group is empty');
    node.leave(group);
    assert.deepEqual(node.groupMembers(group), [], 'left → empty');
    node.stop();
  });

  test('a registry KEY containing the U+001F separator resolves its owner', (assert) => {
    const node = Node.start('a@idx', Node.memoryHub().transport());
    node.register('reg', `a${US}b${US}c`);
    assert.strictEqual(
      node.whereis('reg', `a${US}b${US}c`),
      'a@idx',
      'the owner is parsed past inner separators',
    );
    assert.strictEqual(node.whereis('reg', 'missing'), null, 'an unknown key is null');
    node.stop();
  });

  test('index == a brute-force fact scan after a churny op sequence', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@idx', hub.transport());
    const b = Node.start('b@idx', hub.transport());
    await settle();

    // Ground truth read straight off the replicated facts (what the OLD scan-based code computed).
    const scanMembers = (n: typeof a, group: string) =>
      n
        .facts(`g${US}${group}${US}`)
        .map((f) => f.slice(`g${US}${group}${US}`.length))
        .filter((m) => m === n.self() || n.list().includes(m))
        .sort();
    const idxMembers = (n: typeof a, group: string) => [...n.groupMembers(group)].sort();

    const groups = ['g1', `pubsub${US}t`, 'g2'];
    a.join('g1');
    a.join(`pubsub${US}t`);
    b.join('g1');
    b.join('g2');
    a.join('g2');
    await settle();
    b.leave('g1'); // a leave in the middle
    a.register('reg', 'k1');
    b.register('reg', 'k2');
    await settle();

    for (const g of groups)
      for (const n of [a, b])
        assert.deepEqual(
          idxMembers(n, g),
          scanMembers(n, g),
          `index==scan for ${JSON.stringify(g)} on ${n.self()}`,
        );

    // whereis (registry index) agrees with the fact set too.
    assert.strictEqual(a.whereis('reg', 'k1'), 'a@idx', 'k1 → its owner');
    assert.strictEqual(b.whereis('reg', 'k2'), 'b@idx', 'k2 → its owner');
    assert.strictEqual(
      a.whereis('reg', 'k2'),
      'b@idx',
      'cross-node whereis resolves after convergence',
    );
    a.stop();
    b.stop();
  });

  test('a nodedown hides a peer’s entries without touching the index; they return on recovery', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@idx', hub.transport());
    const b = Node.start('b@idx', hub.transport());
    await settle();
    a.join('room');
    b.join('room');
    await settle();
    assert.deepEqual(a.groupMembers('room').sort(), ['a@idx', 'b@idx'], 'both members visible');

    b.stop(); // nodedown
    await settle();
    assert.deepEqual(a.groupMembers('room'), ['a@idx'], 'a dead peer is filtered out by liveness');
    a.stop();
  });
});
