import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import {
  channelServer,
  channelClient,
  webSocketWire,
  binaryWireCodec,
} from '../../lib/channel/index.ts';
import { serveChannelsOverWs } from '../../lib/channel/ws.ts';
import { pubsub } from '../../lib/pubsub/index.ts';

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

// The REAL last mile: a live WebSocket server accepting inbound sockets, a channelClient dialing
// a native WebSocket — the exact production path a browser takes, JSON and binary codecs both.
module('Channel | WebSocket end-to-end', () => {
  test('join, handleIn reply, and a cluster broadcast over a REAL socket (JSON)', async (assert) => {
    const node = Node.start('gw@wse', Node.memoryHub().transport());
    const bus = pubsub(node);
    const server = channelServer(node, bus, {
      handleIn: (_t, event, payload) => ({ reply: { event, payload } }),
    });
    const edge = serveChannelsOverWs(server, { port: 0 });
    const client = channelClient({
      connect: () => webSocketWire(`ws://127.0.0.1:${edge.port()}`),
      heartbeatMs: false,
    });
    const got: unknown[] = [];
    client.on('room:1', 'msg', (p) => got.push(p));

    assert.deepEqual(await client.join('room:1'), { ok: true }, 'joined over a real socket');
    assert.deepEqual(
      await client.push('room:1', 'calc', 21),
      { reply: { event: 'calc', payload: 21 } },
      'handleIn replied over the socket',
    );
    bus.broadcast('room:1', 'msg', { text: 'live' });
    await settle();
    assert.deepEqual(got, [{ text: 'live' }], 'a broadcast reached the browser-protocol client');

    client.close();
    await edge.close();
    node.stop();
  });

  test('the binary codec crosses the same socket — bytes, not JSON', async (assert) => {
    const node = Node.start('gw@wse', Node.memoryHub().transport());
    const bus = pubsub(node);
    const server = channelServer(node, bus, {});
    const edge = serveChannelsOverWs(server, { port: 0, codec: binaryWireCodec });
    const client = channelClient({
      connect: () => webSocketWire(`ws://127.0.0.1:${edge.port()}`, binaryWireCodec),
      heartbeatMs: false,
    });
    const got: unknown[] = [];
    client.on('room:bin', 'blob', (p) => got.push(p));

    assert.deepEqual(await client.join('room:bin'), { ok: true }, 'joined over the binary wire');
    bus.broadcast('room:bin', 'blob', { n: 42, ok: true });
    await settle();
    assert.deepEqual(got, [{ n: 42, ok: true }], 'a structured payload round-tripped in binary');

    client.close();
    await edge.close();
    node.stop();
  });
  test('serves Channels over an INJECTED http server (the wss path uses https identically)', async (assert) => {
    const { createServer } = await import('node:http');
    const node = Node.start('gw@wsi', Node.memoryHub().transport());
    const bus = pubsub(node);
    const server = channelServer(node, bus, {});
    const http = createServer();
    await new Promise<void>((r) => http.listen(0, r));
    const edge = serveChannelsOverWs(server, { server: http });
    const client = channelClient({
      connect: () => webSocketWire(`ws://127.0.0.1:${edge.port()}`),
      heartbeatMs: false,
    });
    const got: unknown[] = [];
    client.on('room:1', 'msg', (p) => got.push(p));
    try {
      assert.deepEqual(await client.join('room:1'), { ok: true }, 'joined over the shared server');
      bus.broadcast('room:1', 'msg', 'via-injected');
      await settle();
      assert.deepEqual(
        got,
        ['via-injected'],
        'delivery works — the wss path is identical with https',
      );
    } finally {
      client.close();
      await edge.close();
      await new Promise<void>((r) => http.close(() => r())); // the server is ours to close
      node.stop();
    }
  });
});
