import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { channelServer, serveSocket, channelClient, type Wire } from '../../lib/channel/index.ts';
import { pubsub } from '../../lib/pubsub/index.ts';

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

// A pair of linked in-memory wires (client <-> server), with a silent `kill` that stops delivery
// WITHOUT a close event — so the heartbeat is the only thing that can notice the dead connection.
function linkedWires() {
  let ch: ((m: unknown) => void) | undefined;
  let sh: ((m: unknown) => void) | undefined;
  let chClose: (() => void) | undefined;
  let shClose: (() => void) | undefined;
  let dead = false;
  const clientWire: Wire = {
    send: (m) => void (!dead && queueMicrotask(() => sh?.(m))),
    onMessage: (h) => void (ch = h),
    onClose: (h) => void (chClose = h),
    close: () => void (!dead && ((dead = true), queueMicrotask(() => shClose?.()))),
  };
  const serverWire: Wire = {
    send: (m) => void (!dead && queueMicrotask(() => ch?.(m))),
    onMessage: (h) => void (sh = h),
    onClose: (h) => void (shClose = h),
    close: () => void (!dead && ((dead = true), queueMicrotask(() => chClose?.()))),
  };
  return { clientWire, serverWire, kill: () => void (dead = true) };
}

function harness() {
  const node = Node.start('gw@wc', Node.memoryHub().transport());
  const bus = pubsub(node);
  const server = channelServer(node, bus, {
    join: (topic) => (topic === 'blocked' ? { error: 'no' } : { ok: true }),
    handleIn: (_t, event, payload) => ({ reply: { event, payload } }),
  });
  const pairs: ReturnType<typeof linkedWires>[] = [];
  const connect = () => {
    const pair = linkedWires();
    pairs.push(pair);
    serveSocket(server, pair.serverWire);
    return pair.clientWire;
  };
  return { node, bus, connect, pairs };
}

module('Channel | WebSocket client', () => {
  test('join, receive a broadcast push, and get a handleIn reply over the wire', async (assert) => {
    const { node, bus, connect } = harness();
    const client = channelClient({ connect, heartbeatMs: false });
    const got: unknown[] = [];
    client.on('room:1', 'msg', (p) => got.push(p));

    assert.deepEqual(await client.join('room:1'), { ok: true }, 'join authorized');
    assert.deepEqual(await client.join('blocked'), { error: 'no' }, 'join denied surfaces');

    bus.broadcast('room:1', 'msg', 'hello');
    await settle();
    assert.deepEqual(got, ['hello'], 'a broadcast was pushed to the client');

    assert.deepEqual(
      await client.push('room:1', 'calc', 5),
      { reply: { event: 'calc', payload: 5 } },
      'handleIn reply came back over the wire',
    );
    client.close();
    node.stop();
  });

  test('a dead connection is detected by heartbeat, reconnected, and topics auto-rejoined', async (assert) => {
    const { node, bus, connect, pairs } = harness();
    const client = channelClient({ connect, heartbeatMs: 20 });
    const got: unknown[] = [];
    client.on('room:1', 'msg', (p) => got.push(p));
    await client.join('room:1');

    bus.broadcast('room:1', 'msg', 'before');
    await settle();
    assert.deepEqual(got, ['before'], 'delivery works on the first connection');

    pairs[0].kill(); // silent death — only the heartbeat can notice
    await settle(150); // heartbeat misses its echo → reconnect → connect() → rejoin
    assert.true(pairs.length >= 2, 'the client reconnected (a new wire was dialed)');

    bus.broadcast('room:1', 'msg', 'after');
    await settle();
    assert.true(
      (got as string[]).includes('after'),
      'delivery resumed after reconnect + auto-rejoin',
    );
    client.close();
    node.stop();
  });
});
