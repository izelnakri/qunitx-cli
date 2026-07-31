import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { traceTransport } from '../../lib/node/ws.ts';

const settleMs = (ms = 15) => new Promise((r) => setTimeout(r, ms));

module('Node | observer protocol', () => {
  test('sys.node.info reports peers, groups, and served units — read from ANOTHER node', async (assert) => {
    const hub = Node.memoryHub();
    const svc = Node.start('svc@memory', hub.transport());
    const ops = Node.start('ops@memory', hub.transport());
    Node.genServer(svc, 'greeter', {
      version: '1.2.3',
      init: () => 0,
      handlers: { hi: (s) => ({ state: s, reply: 'hi' }) },
    });
    svc.join('ledger');
    await settleMs();

    const info = await ops.call<{
      name: string;
      peers: string[];
      groups: Record<string, string[]>;
      units: { name: string; version: string; mailboxDepth: number; alive: boolean }[];
    }>('svc@memory', 'sys.node.info');
    assert.strictEqual(info.name, 'svc@memory');
    assert.deepEqual(info.peers, ['ops@memory']);
    assert.deepEqual(info.groups.ledger, ['svc@memory'], 'group membership visible');
    const unit = info.units.find((u) => u.name === 'greeter')!;
    assert.strictEqual(unit.version, '1.2.3', 'the served unit and its live version');
    assert.strictEqual(unit.alive, true);
    assert.strictEqual(typeof unit.mailboxDepth, 'number');
    svc.stop();
    ops.stop();
  });

  test('a browser dashboard is just a node polling sys.node.info across the cluster', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@memory', hub.transport());
    const b = Node.start('b@memory', hub.transport());
    const dash = Node.start('dash@memory', hub.transport()); // a browser tab, in prod
    Node.genServer(a, 'svcA', { version: '1', init: () => 0, handlers: {} });
    Node.genServer(b, 'svcB', { version: '2', init: () => 0, handlers: {} });
    await settleMs();

    const cluster = await Promise.all(
      dash
        .list()
        .map((peer) =>
          dash.call<{ name: string; units: { name: string }[] }>(peer, 'sys.node.info'),
        ),
    );
    const services = cluster.flatMap((n) => n.units.map((u) => `${n.name}/${u.name}`)).sort();
    assert.deepEqual(
      services,
      ['a@memory/svcA', 'b@memory/svcB'],
      'the whole topology, from one poll',
    );
    a.stop();
    b.stop();
    dash.stop();
  });
});

module('Node | frame tracing', () => {
  test('traceTransport sees every frame both directions — the :dbg seam', async (assert) => {
    const hub = Node.memoryHub();
    const log: string[] = [];
    const a = Node.start(
      'a@memory',
      traceTransport(hub.transport(), (dir, frame) => log.push(`${dir}:${frame.kind}`)),
    );
    const b = Node.start('b@memory', hub.transport());
    b.handle('echo', (x) => x);
    await settleMs();
    await a.call('b@memory', 'echo', 1);
    assert.true(log.includes('out:hello'), 'saw its own hello go out');
    assert.true(log.includes('in:hello'), "saw b's hello arrive");
    assert.true(log.includes('out:call'), 'saw the call frame');
    assert.true(log.includes('in:reply'), 'saw the reply frame');
    a.stop();
    b.stop();
  });
});
