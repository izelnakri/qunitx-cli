import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { startRoomHost } from '../../examples/realtime-chat/src/room-host.ts';
import { chat } from '../../examples/realtime-chat/src/chat-client.ts';

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

module('Examples | realtime-chat handoff', () => {
  test('graceful drain hands a room to its successor — pre-warmed, no cold miss', async (assert) => {
    const hub = Node.memoryHub();
    const store = Node.memoryStore(); // SHARED — the durable handoff channel (a Postgres store in prod)
    let hostA = startRoomHost('host-a@chat', hub.transport(), store);
    let hostB = startRoomHost('host-b@chat', hub.transport(), store);
    const gw = Node.start('gw@chat', hub.transport());
    await settle();

    const lobby = chat(gw, 'lobby');
    await lobby.join('ada');
    await lobby.say('ada', 'before the drain');
    const owner = gw.whereis('rooms', 'lobby');
    assert.ok(owner === 'host-a@chat' || owner === 'host-b@chat', 'a host owns the room');

    // Gracefully drain the owner — it re-homes the room to the other host BEFORE leaving.
    const draining = owner === 'host-a@chat' ? hostA : hostB;
    await draining.drain();
    if (owner === 'host-a@chat') hostA = null as never;
    else hostB = null as never;
    await settle(); // registry gossip settles on the successor

    // The proof of a LIVE handoff (vs a cold rehydrate on first access): whereis already points
    // at the successor and history is intact WITHOUT the gateway triggering an ensureRoom.
    const newOwner = gw.whereis('rooms', 'lobby');
    assert.notEqual(newOwner, owner, 'the room moved off the drained host');
    assert.notEqual(newOwner, null, 'the successor is already registered (pre-warmed)');

    const history = await chat(gw, 'lobby').history();
    assert.deepEqual(
      history.map((m) => m.text),
      ['before the drain'],
      'the persisted history survived the handoff',
    );

    if (hostA) await hostA.stop();
    if (hostB) await hostB.stop();
    gw.stop();
  });

  test('draining the LAST host leaves state durable for a later cold start', async (assert) => {
    const hub = Node.memoryHub();
    const store = Node.memoryStore();
    const host = startRoomHost('solo@chat', hub.transport(), store);
    const gw = Node.start('gw@chat', hub.transport());
    await settle();

    const room = chat(gw, 'lobby');
    await room.join('ada'); // starts + registers the room
    await room.say('ada', 'persist me'); // persisted before ack
    await host.drain(); // no successor: rooms stop, but the store keeps the state
    await settle();
    assert.equal(gw.whereis('rooms', 'lobby'), null, 'no owner once the last host drains');

    // A fresh host cold-rehydrates the room from the shared store — nothing was lost.
    const revived = startRoomHost('solo2@chat', hub.transport(), store);
    await settle();
    const revivedRoom = chat(gw, 'lobby');
    await revivedRoom.join('bo'); // cold start on the new host → loads state from the store
    const history = await revivedRoom.history();
    assert.deepEqual(
      history.map((m) => m.text),
      ['persist me'],
      'the last-host drain preserved durable state',
    );

    await revived.stop();
    gw.stop();
  });
});
