import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { channelServer, type Socket } from '../../lib/channel/index.ts';
import { pubsub } from '../../lib/pubsub/index.ts';
import { presence } from '../../lib/presence/index.ts';

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

// A test socket that records everything the server pushes to it.
function fakeSocket(id: string): Socket & { sent: unknown[][] } {
  const sent: unknown[][] = [];
  return { id, sent, push: (topic, event, payload) => void sent.push([topic, event, payload]) };
}

module('Channel | Phoenix Channels', () => {
  test('join authorizes — allow and deny', (assert) => {
    const node = Node.start('gw@ch', Node.memoryHub().transport());
    const server = channelServer(node, pubsub(node), {
      join: (topic) => (topic.startsWith('public:') ? { ok: true } : { error: 'forbidden' }),
    });
    const conn = server.connect(fakeSocket('c1'));
    assert.deepEqual(conn.join('public:1'), { ok: true }, 'allowed');
    assert.deepEqual(conn.join('private:1'), { error: 'forbidden' }, 'denied');
    node.stop();
  });

  test('a broadcast reaches a joined socket; leave stops it', async (assert) => {
    const node = Node.start('gw@ch', Node.memoryHub().transport());
    const server = channelServer(node, pubsub(node), {});
    const socket = fakeSocket('c1');
    const conn = server.connect(socket);
    conn.join('room:1');
    conn.broadcast('room:1', 'msg', 'hello');
    await settle();
    assert.deepEqual(socket.sent, [['room:1', 'msg', 'hello']], 'delivered to the joined socket');

    conn.leave('room:1');
    conn.broadcast('room:1', 'msg', 'after-leave');
    await settle();
    assert.equal(socket.sent.length, 1, 'no delivery after leaving');
    node.stop();
  });

  test('handleIn returns a reply to the sender', async (assert) => {
    const node = Node.start('gw@ch', Node.memoryHub().transport());
    const server = channelServer(node, pubsub(node), {
      handleIn: (_topic, event, payload) => ({
        reply: { event, doubled: (payload as number) * 2 },
      }),
    });
    const conn = server.connect(fakeSocket('c1'));
    conn.join('room:1');
    assert.deepEqual(await conn.push('room:1', 'calc', 21), {
      reply: { event: 'calc', doubled: 42 },
    });
    node.stop();
  });

  test('a broadcast on one node reaches a client on ANOTHER node', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('gw-a@ch', hub.transport());
    const b = Node.start('gw-b@ch', hub.transport());
    const serverA = channelServer(a, pubsub(a), {});
    const serverB = channelServer(b, pubsub(b), {});

    const socketB = fakeSocket('cb');
    serverB.connect(socketB).join('room:shared');
    const connA = serverA.connect(fakeSocket('ca'));
    connA.join('room:shared');
    await settle(); // group membership gossips across the hub

    connA.broadcast('room:shared', 'msg', { from: 'a' });
    await settle();
    assert.deepEqual(socketB.sent, [['room:shared', 'msg', { from: 'a' }]], 'cross-node delivery');
    a.stop();
    b.stop();
  });

  test('Presence composes: joining a channel tracks who is in the topic', async (assert) => {
    const node = Node.start('gw@ch', Node.memoryHub().transport());
    const bus = pubsub(node);
    const pres = presence(node, bus);
    // The app wires presence into the channel lifecycle: track on join.
    const server = channelServer(node, bus, {
      join: (topic, payload, socket) => {
        pres.track(topic, socket.id, { user: (payload as { user: string }).user });
        return { ok: true };
      },
    });
    server.connect(fakeSocket('c1')).join('room:1', { user: 'ada' });
    const conn2 = server.connect(fakeSocket('c2'));
    conn2.join('room:1', { user: 'bo' });
    await settle();

    assert.deepEqual(
      Object.keys(pres.list('room:1')).sort(),
      ['c1', 'c2'],
      'both joined clients are present in the topic',
    );
    node.stop();
  });
});

module('Channel | lifecycle hooks', () => {
  test('onJoin/onLeave fire — including for a socket that just disconnects', (assert) => {
    const node = Node.start('gw@hooks', Node.memoryHub().transport());
    const events: string[] = [];
    const server = channelServer(node, pubsub(node), {
      onJoin: (topic, _payload, socket) => void events.push(`join:${topic}:${socket.id}`),
      onLeave: (topic, socket) => void events.push(`leave:${topic}:${socket.id}`),
    });
    const conn = server.connect(fakeSocket('c1'));
    conn.join('room:1');
    conn.join('room:2');
    conn.leave('room:1'); // explicit leave
    conn.disconnect(); // a vanished socket — room:2 must be released too
    assert.deepEqual(events, [
      'join:room:1:c1',
      'join:room:2:c1',
      'leave:room:1:c1',
      'leave:room:2:c1',
    ]);
    assert.equal(events.filter((e) => e === 'leave:room:1:c1').length, 1, 'no double-leave');
    node.stop();
  });

  test('an async handleIn resolves the reply AFTER its awaited work', async (assert) => {
    const node = Node.start('gw@hooks', Node.memoryHub().transport());
    let settledFirst = '';
    const server = channelServer(node, pubsub(node), {
      handleIn: async () => {
        await new Promise((r) => setTimeout(r, 20));
        settledFirst ||= 'work';
        return { reply: 'done-after-work' };
      },
    });
    const conn = server.connect(fakeSocket('c1'));
    conn.join('t');
    const reply = conn.push('t', 'e').then((r) => ((settledFirst ||= 'reply'), r));
    assert.deepEqual(await reply, { reply: 'done-after-work' });
    assert.equal(settledFirst, 'work', 'the awaited work finished before the reply settled');
    node.stop();
  });
});
