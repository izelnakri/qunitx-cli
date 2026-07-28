import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { startRoomHost } from '../../examples/realtime-chat/src/room-host.ts';
import { chatGateway } from '../../examples/realtime-chat/src/chat-channels.ts';
import type { Socket } from '../../lib/channel/index.ts';

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

function fakeSocket(id: string): Socket & { pushes: unknown[][] } {
  const pushes: unknown[][] = [];
  return { id, pushes, push: (topic, event, payload) => void pushes.push([topic, event, payload]) };
}

module('Examples | chat over Channels + Presence', () => {
  test('two clients join a room, a message fans out to both, Presence lists them', async (assert) => {
    const hub = Node.memoryHub();
    const store = Node.memoryStore();
    const host = startRoomHost('host-a@chat', hub.transport(), store);
    const gwNode = Node.start('gw@chat', hub.transport());
    const gw = chatGateway(gwNode);
    await settle();

    const s1 = fakeSocket('c1');
    const s2 = fakeSocket('c2');
    const ada = gw.connect(s1);
    const bo = gw.connect(s2);
    assert.deepEqual(ada.join('room:lobby', { user: 'ada' }), { ok: true }, 'ada joined');
    assert.deepEqual(bo.join('room:lobby', { user: 'bo' }), { ok: true }, 'bo joined');
    await settle();

    // Presence knows who's in the room.
    assert.deepEqual(
      Object.keys(gw.presence.list('room:lobby')).sort(),
      ['c1', 'c2'],
      'both clients are present in the room',
    );

    // ada sends a message → appended to the durable room actor → broadcast to every joined client.
    const ack = await ada.push('room:lobby', 'message', { user: 'ada', text: 'hi bo 👋' });
    assert.equal(
      (ack as { reply: { text: string } }).reply.text,
      'hi bo 👋',
      'the ASYNC reply carries the stored message',
    );
    await settle();

    const gotText = (s: typeof s1) =>
      s.pushes
        .filter(([t, e]) => t === 'room:lobby' && e === 'message')
        .map(([, , p]) => (p as { text: string }).text);
    assert.deepEqual(gotText(s1), ['hi bo 👋'], 'ada (sender) saw the message via broadcast');
    assert.deepEqual(gotText(s2), ['hi bo 👋'], 'bo saw the message too');

    // And it's durable: the room actor has it in history.
    const history = await gwNode.call<{ text: string }[]>('via:rooms/lobby', 'room:lobby.history');
    assert.deepEqual(
      history.map((m) => m.text),
      ['hi bo 👋'],
      'the message was persisted in the durable room actor',
    );

    await host.stop();
    gwNode.stop();
  });
});
