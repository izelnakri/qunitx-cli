import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { Failure } from '../../lib/result/index.ts';

const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const behavior = () => ({
  version: '1',
  init: () => 0,
  handlers: { noop: (n: number) => ({ state: n, reply: n }) },
});
const Boom = Failure.define('Boom', 'crashed');

// A distributed link joins a LOCAL unit to a unit on ANOTHER node: an exit on either side, or the
// remote node going down, signals the other — Erlang's `link/1` across the distribution channel.
module('Node | distributed links (cross-node link/1)', () => {
  test('a remote unit exiting takes a linked local unit down', async (assert) => {
    const hub = Node.memoryHub();
    const n1 = Node.start('n1@dl', hub.transport());
    const n2 = Node.start('n2@dl', hub.transport());
    await settle();
    const a = Node.genServer(n1, 'A', behavior());
    const b = Node.genServer(n2, 'B', behavior());
    a.link({ node: 'n2@dl', name: 'B' });
    await settle();

    b.exit(Boom());
    await settle();
    assert.false(a.isAlive(), 'A died when its remote link B crashed');
    n1.stop();
    n2.stop();
  });

  test('a trapping local unit RECEIVES the remote exit instead of dying', async (assert) => {
    const hub = Node.memoryHub();
    const n1 = Node.start('n1@dl', hub.transport());
    const n2 = Node.start('n2@dl', hub.transport());
    await settle();
    const a = Node.genServer(n1, 'A', behavior());
    const b = Node.genServer(n2, 'B', behavior());
    const seen: { from: string; code: string }[] = [];
    a.trapExit((from, reason) => seen.push({ from, code: (reason as Failure.Any).code }));
    a.link({ node: 'n2@dl', name: 'B' });
    await settle();

    b.exit(Boom());
    await settle();
    assert.true(a.isAlive(), 'A trapped the exit and survived');
    assert.strictEqual(seen.length, 1, 'A got exactly one exit signal');
    assert.strictEqual(seen[0].code, 'Boom', 'carrying the remote reason');
    assert.true(seen[0].from.includes('B'), 'attributed to the remote unit');
    n1.stop();
    n2.stop();
  });

  test('a nodedown fires the remote link as a NodeDown exit', async (assert) => {
    const hub = Node.memoryHub();
    const n1 = Node.start('n1@dl', hub.transport());
    const n2 = Node.start('n2@dl', hub.transport());
    await settle();
    const a = Node.genServer(n1, 'A', behavior());
    Node.genServer(n2, 'B', behavior());
    const seen: string[] = [];
    a.trapExit((_from, reason) => seen.push((reason as Failure.Any).code));
    a.link({ node: 'n2@dl', name: 'B' });
    await settle();

    n2.stop(); // the remote node goes down
    await settle();
    assert.deepEqual(seen, ['NodeDown'], 'the remote link fired as a NodeDown exit');
    n1.stop();
  });

  test('links are symmetric across the wire — A exiting takes remote B down', async (assert) => {
    const hub = Node.memoryHub();
    const n1 = Node.start('n1@dl', hub.transport());
    const n2 = Node.start('n2@dl', hub.transport());
    await settle();
    const a = Node.genServer(n1, 'A', behavior());
    const b = Node.genServer(n2, 'B', behavior());
    a.link({ node: 'n2@dl', name: 'B' });
    await settle();

    a.exit(Boom());
    await settle();
    assert.false(b.isAlive(), 'B died when its remote linker A exited (symmetric)');
    n1.stop();
    n2.stop();
  });

  test('linking to a nonexistent remote unit fires immediately (NoProc)', async (assert) => {
    const hub = Node.memoryHub();
    const n1 = Node.start('n1@dl', hub.transport());
    const n2 = Node.start('n2@dl', hub.transport());
    await settle();
    const a = Node.genServer(n1, 'A', behavior());
    const seen: string[] = [];
    a.trapExit((_from, reason) => seen.push((reason as Failure.Any).code));
    a.link({ node: 'n2@dl', name: 'ghost' });
    await settle();
    assert.deepEqual(seen, ['NoProc'], 'linking a missing remote unit signals NoProc at once');
    n1.stop();
    n2.stop();
  });
});
