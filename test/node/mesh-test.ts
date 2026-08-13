import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { meshTransport, meshNetwork } from '../../lib/node/index.ts';

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

module('Node | mesh transport', () => {
  test('a directed call routes peer-to-peer with no hub', async (assert) => {
    const net = meshNetwork(['a@mesh', 'b@mesh']);
    const a = Node.start('a@mesh', meshTransport('a@mesh', net.for('a@mesh')));
    const b = Node.start('b@mesh', meshTransport('b@mesh', net.for('b@mesh')));
    b.handle('add', (p) => (p as number[]).reduce((x, y) => x + y, 0));
    assert.equal(await a.call('b@mesh', 'add', [20, 22]), 42, 'call crossed the direct link');
    a.stop();
    b.stop();
  });

  test('gossip (registry) converges across the mesh', async (assert) => {
    const net = meshNetwork(['a@mesh', 'b@mesh', 'c@mesh']);
    const nodes = ['a@mesh', 'b@mesh', 'c@mesh'].map((n) =>
      Node.start(n, meshTransport(n, net.for(n))),
    );
    await settle();
    nodes[0].register('rooms', 'lobby');
    await settle();
    assert.deepEqual(
      nodes.map((n) => n.whereis('rooms', 'lobby')),
      ['a@mesh', 'a@mesh', 'a@mesh'],
      'every node learned the registration over the mesh',
    );
    for (const n of nodes) n.stop();
  });

  test('every pair in a 3-node mesh is mutually reachable', async (assert) => {
    const names = ['a@mesh', 'b@mesh', 'c@mesh'];
    const net = meshNetwork(names);
    const nodes = names.map((n) => Node.start(n, meshTransport(n, net.for(n))));
    for (const n of nodes) n.handle('ping', () => n.self());
    await settle();
    for (const from of nodes)
      for (const to of names)
        if (to !== from.self())
          assert.equal(await from.call(to, 'ping'), to, `${from.self()} → ${to}`);
    for (const n of nodes) n.stop();
  });

  test('a peer discovered after start is linked on the next poll', async (assert) => {
    const members: string[] = ['a@mesh'];
    const net = meshNetwork(members);
    const a = Node.start('a@mesh', meshTransport('a@mesh', { ...net.for('a@mesh'), pollMs: 15 }));
    a.handle('hi', () => 'from-a');
    // b joins the roster AFTER a is already running.
    members.push('b@mesh');
    const b = Node.start('b@mesh', meshTransport('b@mesh', { ...net.for('b@mesh'), pollMs: 15 }));
    b.handle('hi', () => 'from-b');
    await settle(); // a's poll discovers b and links it
    assert.equal(await a.call('b@mesh', 'hi'), 'from-b', 'a linked the late-joining peer');
    a.stop();
    b.stop();
  });
});

module('Node | mesh gossip fan-out', () => {
  test('with gossipFanout the sender pays O(k) and the whole mesh still converges', async (assert) => {
    const names = Array.from({ length: 9 }, (_, i) => `n${i}@fan`);
    const net = meshNetwork(names);
    // Count how many links the SENDER pushes each crdt broadcast onto.
    let senderCrdtSends = 0;
    const counted = (base: ReturnType<typeof net.for>) => ({
      ...base,
      link: (peer: string) => {
        const inner = base.link(peer);
        return {
          ...inner,
          send: (f: Node.Frame) => {
            if (f.kind === 'crdt' && f.from === 'n0@fan' && f.to === undefined) senderCrdtSends++;
            inner.send(f);
          },
        };
      },
    });
    const nodes = names.map((n, i) =>
      Node.start(
        n,
        meshTransport(n, {
          ...(i === 0 ? counted(net.for(n)) : net.for(n)),
          gossipFanout: 2,
          pollMs: 20,
        }),
        { antiEntropyMs: 100, tick: false }, // gossip spreads fast; anti-entropy guarantees completeness
      ),
    );
    await new Promise((r) => setTimeout(r, 150)); // hellos + full-state pushes settle

    senderCrdtSends = 0; // measure ONLY the register broadcast below
    nodes[0].register('rooms', 'lobby');
    const deadline = Date.now() + 4000;
    while (!nodes.every((n) => n.whereis('rooms', 'lobby') === 'n0@fan') && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));

    assert.deepEqual(
      nodes.map((n) => n.whereis('rooms', 'lobby')),
      names.map(() => 'n0@fan'),
      'all nine nodes learned the registration through epidemic relay',
    );
    assert.true(
      senderCrdtSends <= 4,
      `the sender fanned out to ~k links, not all 8 (sent ${senderCrdtSends})`,
    );
    for (const n of nodes) n.stop();
  });
});
