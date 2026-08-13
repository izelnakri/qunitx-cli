import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import {
  channelServer,
  channelClient,
  longPollEndpoint,
  longPollWire,
} from '../../lib/channel/index.ts';
import { pubsub } from '../../lib/pubsub/index.ts';

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

module('Channel | long-poll fallback', () => {
  test('the full channel protocol works over plain POSTs — join, push, broadcast', async (assert) => {
    const node = Node.start('gw@lp', Node.memoryHub().transport());
    const bus = pubsub(node);
    const server = channelServer(node, bus, {
      handleIn: (_t, event, payload) => ({ reply: { event, payload } }),
    });
    const endpoint = longPollEndpoint(server, { holdMs: 200 });
    const client = channelClient({
      connect: () => longPollWire((body) => endpoint.handle(body)),
      heartbeatMs: false,
    });
    const got: unknown[] = [];
    client.on('room:1', 'msg', (p) => got.push(p));

    assert.deepEqual(await client.join('room:1'), { ok: true }, 'join over long-poll');
    assert.deepEqual(
      await client.push('room:1', 'calc', 21),
      { reply: { event: 'calc', payload: 21 } },
      'handleIn reply over long-poll',
    );

    bus.broadcast('room:1', 'msg', 'held-poll-delivery');
    await settle(150); // the held poll wakes with the push
    assert.deepEqual(
      got,
      ['held-poll-delivery'],
      'a broadcast reached the client via the held poll',
    );

    client.close();
    await settle();
    node.stop();
  });

  test('an expired session is reopened transparently; bye ends it', async (assert) => {
    const node = Node.start('gw@lp', Node.memoryHub().transport());
    const server = channelServer(node, pubsub(node), {});
    const endpoint = longPollEndpoint(server, { holdMs: 50, ttlMs: 40 });

    const first = await endpoint.handle({});
    assert.ok(first.session, 'first contact opens a session');

    await settle(80); // past ttl — the sweep will reap it on the next request
    const second = await endpoint.handle({ session: first.session });
    assert.notEqual(second.session, first.session, 'an expired session was reopened as a new one');

    const bye = await endpoint.handle({ session: second.session, bye: true });
    assert.deepEqual(bye.messages, [], 'bye acknowledges with no messages');
    node.stop();
  });
});
