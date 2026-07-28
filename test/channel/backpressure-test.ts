import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { channelServer, serveSocket, type Wire } from '../../lib/channel/index.ts';
import { pubsub } from '../../lib/pubsub/index.ts';
import { rateLimiter } from '../../lib/node/index.ts';

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

module('Channel | backpressure guards', () => {
  test('a slow client (pending past maxPending) is dropped, not queued forever', async (assert) => {
    const node = Node.start('gw@bp', Node.memoryHub().transport());
    const bus = pubsub(node);
    const server = channelServer(node, bus, {});

    let backlog = 0; // the simulated unflushed bytes on the socket
    const sent: unknown[] = [];
    let closed = false;
    let inbound: (msg: unknown) => void = () => {};
    const wire: Wire = {
      send: (m) => void sent.push(m),
      onMessage: (h) => void (inbound = h),
      pending: () => backlog,
      close: () => void (closed = true),
    };
    let slow = 0;
    serveSocket(server, wire, { maxPending: 100, onSlowClient: () => void slow++ });
    inbound({ t: 'join', ref: 1, topic: 'room:1' });
    await settle();

    bus.broadcast('room:1', 'msg', 'fits');
    await settle();
    assert.true(
      sent.some((m) => (m as { t: string }).t === 'push'),
      'a healthy client gets pushes',
    );

    backlog = 10_000; // the client stopped draining
    bus.broadcast('room:1', 'msg', 'overflow');
    await settle();
    assert.equal(slow, 1, 'the slow-client guard fired');
    assert.true(closed, 'the wire was closed');

    const before = sent.length;
    bus.broadcast('room:1', 'msg', 'after-drop');
    await settle();
    assert.equal(sent.length, before, 'a dropped client receives nothing further');
    node.stop();
  });

  test('inbound events beyond the rate limit are throttled before handleIn', (assert) => {
    const node = Node.start('gw@bp', Node.memoryHub().transport());
    let handled = 0;
    const server = channelServer(node, pubsub(node), {
      handleIn: () => void handled++,
    });
    const replies: unknown[] = [];
    let inbound: (msg: unknown) => void = () => {};
    const clock = { t: 0 };
    const wire: Wire = {
      send: (m) => void replies.push(m),
      onMessage: (h) => void (inbound = h),
      close: () => void 0,
    };
    serveSocket(server, wire, {
      inbound: rateLimiter({ capacity: 2, refillPerSec: 1, now: () => clock.t }),
    });
    inbound({ t: 'join', ref: 1, topic: 'room:1' });

    inbound({ t: 'event', ref: 2, topic: 'room:1', event: 'e' });
    inbound({ t: 'event', ref: 3, topic: 'room:1', event: 'e' });
    inbound({ t: 'event', ref: 4, topic: 'room:1', event: 'e' }); // over the burst
    assert.equal(handled, 2, 'only the in-budget events reached handleIn');
    const throttled = replies.find(
      (m) => (m as { ref?: number; result?: { error?: string } }).ref === 4,
    ) as { result: { error: string } };
    assert.deepEqual(
      throttled.result,
      { error: 'throttled' },
      'the excess event was answered throttled',
    );
    node.stop();
  });
});
