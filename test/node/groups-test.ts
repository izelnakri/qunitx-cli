import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { Failure } from '../../lib/task/index.ts';

const settleMs = (ms = 15) => new Promise((r) => setTimeout(r, ms));

module('Node | process groups', () => {
  test('join gossips membership — late joiners learn the topology from hello answers', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@memory', hub.transport());
    a.join('ledger');
    await settleMs();
    const late = Node.start('late@memory', hub.transport()); // joins the CLUSTER after the group formed
    await settleMs();
    assert.deepEqual(late.groupMembers('ledger'), ['a@memory'], 'learned via hello + join gossip');
    assert.deepEqual(a.groupMembers('ledger'), ['a@memory'], 'self is a member too');
    a.stop();
    late.stop();
  });

  test('group calls round-robin the members — a SERVICE, not a node', async (assert) => {
    const hub = Node.memoryHub();
    const s1 = Node.start('s1@memory', hub.transport());
    const s2 = Node.start('s2@memory', hub.transport());
    const cli = Node.start('cli@memory', hub.transport());
    s1.handle('who', () => 's1');
    s2.handle('who', () => 's2');
    s1.join('ledger');
    s2.join('ledger');
    await settleMs();
    const served = new Set([
      await cli.call('group:ledger', 'who'),
      await cli.call('group:ledger', 'who'),
      await cli.call('group:ledger', 'who'),
      await cli.call('group:ledger', 'who'),
    ]);
    assert.deepEqual([...served].sort(), ['s1', 's2'], 'both members took traffic');
    s1.stop();
    s2.stop();
    cli.stop();
  });

  test('a dead member is pruned — traffic routes to the survivor only', async (assert) => {
    const hub = Node.memoryHub();
    const s1 = Node.start('s1@memory', hub.transport());
    const s2 = Node.start('s2@memory', hub.transport());
    const cli = Node.start('cli@memory', hub.transport());
    s1.handle('who', () => 's1');
    s2.handle('who', () => 's2');
    s1.join('ledger');
    s2.join('ledger');
    await settleMs();
    s2.stop(); // bye prunes it from every group on every node
    await settleMs();
    assert.deepEqual(cli.groupMembers('ledger'), ['s1@memory']);
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(await cli.call('group:ledger', 'who'), 's1', 'survivor serves all');
    }
    s1.stop();
    cli.stop();
  });

  test('an empty group rejects with a declared NoGroupMembers', async (assert) => {
    const hub = Node.memoryHub();
    const cli = Node.start('cli@memory', hub.transport());
    const outcome = await cli.call('group:ghosts', 'anything').result();
    assert.true(Failure.is(outcome));
    assert.strictEqual((outcome as Failure.Any).code, 'NoGroupMembers');
    cli.stop();
  });

  test('a group cast reaches EVERY member, including self', async (assert) => {
    const hub = Node.memoryHub();
    const s1 = Node.start('s1@memory', hub.transport());
    const s2 = Node.start('s2@memory', hub.transport());
    const seen: string[] = [];
    s1.handle('refresh', (_p, from) => void seen.push(`s1<-${from}`));
    s2.handle('refresh', (_p, from) => void seen.push(`s2<-${from}`));
    s1.join('caches');
    s2.join('caches');
    await settleMs();
    s1.cast('group:caches', 'refresh', null); // s1 broadcasts to the group IT belongs to
    await settleMs();
    assert.deepEqual(seen.sort(), ['s1<-s1@memory', 's2<-s1@memory'], 'peers AND self');
    s1.stop();
    s2.stop();
  });

  test('a node can call a group it is the sole member of — self-delivery loops back', async (assert) => {
    const hub = Node.memoryHub();
    const solo = Node.start('solo@memory', hub.transport());
    solo.handle('work', (n) => (n as number) * 2);
    solo.join('workers');
    assert.strictEqual(await solo.call('group:workers', 'work', 21), 42);
    solo.stop();
  });
});

// ── point-to-point routing — the O(N^2) fix ──────────────────────────────────

module('Node | point-to-point routing', () => {
  test('a directed call reaches ONLY its target; gossip still reaches everyone', async (assert) => {
    const hub = Node.memoryHub();
    // A spy transport joins the hub and records every frame it is delivered.
    const seen: string[] = [];
    const spyTransport = hub.transport();
    spyTransport.onFrame((frame) => seen.push(`${frame.kind}:${frame.to ?? '*'}`));
    // The spy must announce itself so the hub learns names; send a hello as a bystander node.
    spyTransport.send({ kind: 'hello', from: 'spy@memory' });

    const a = Node.start('a@memory', hub.transport());
    const b = Node.start('b@memory', hub.transport());
    b.handle('echo', (x) => x);
    await new Promise((r) => setTimeout(r, 20));
    seen.length = 0; // ignore the join-time gossip; measure the call

    assert.strictEqual(await a.call('b@memory', 'echo', 1), 1);
    await new Promise((r) => setTimeout(r, 10));
    // The call frame and its reply are addressed a<->b; the SPY (an uninterested node) must
    // not have seen either — that is the point-to-point property.
    assert.false(
      seen.some((s) => s.startsWith('call:') || s.startsWith('reply:')),
      `spy saw: ${seen.join(',')}`,
    );

    // But a gossip frame (no `to`) DOES reach the spy — membership still converges cluster-wide.
    a.join('workers');
    await new Promise((r) => setTimeout(r, 10));
    assert.true(
      seen.some((s) => s.startsWith('join:')),
      'gossip broadcasts to all',
    );
    a.stop();
    b.stop();
  });
});
