// A runnable, self-contained demo — two room hosts + two gateways in ONE process over an
// in-process hub, sharing ONE memoryStore to SIMULATE a shared Postgres (cross-host durability).
// In production the hosts/gateways are separate pods over a real hub, sharing a postgresStore()
// — the code is identical. Run: node src/demo.ts
import * as Node from '../../../lib/node/index.ts';
import { startRoomHost } from './room-host.ts';
import { chat } from './chat-client.ts';

const settle = () => new Promise((r) => setTimeout(r, 40));
const hub = Node.memoryHub();
const store = Node.memoryStore(); // SHARED across hosts → simulates a durable Postgres store

let hostA = startRoomHost('host-a@chat', hub.transport(), store);
let hostB = startRoomHost('host-b@chat', hub.transport(), store);
const gw1 = Node.start('gw1@chat', hub.transport());
const gw2 = Node.start('gw2@chat', hub.transport());
await settle();

console.log('--- ada & bo chat in #lobby, from two different gateways ---');
const adaLobby = chat(gw1, 'lobby');
await adaLobby.join('ada'); // cold: rendezvous picks a host, spawns + registers the room
await chat(gw2, 'lobby').join('bo');
await adaLobby.say('ada', 'hi bo 👋');
await adaLobby.say('ada', 'how are you?');
const owner = gw1.whereis('rooms', 'lobby');
console.log('#lobby lives on:', owner);
console.log(
  'history:',
  (await adaLobby.history()).map((m) => `${m.user}: ${m.text}`),
);

console.log(`\n--- ${owner} DIES (crash) — its rooms are gone in memory ---`);
if (owner === 'host-a@chat') (await hostA.stop(), (hostA = null as never));
else (await hostB.stop(), (hostB = null as never));
await settle(); // Registry prunes the dead owner; rendezvous re-selects a survivor

console.log('--- ada reconnects to #lobby → it REHYDRATES on a new host from the shared store ---');
const revived = chat(gw1, 'lobby');
await revived.join('ada'); // cold again on the survivor — but state loads from the store
console.log('#lobby now lives on:', gw1.whereis('rooms', 'lobby'), '(a DIFFERENT host)');
console.log(
  'history SURVIVED:',
  (await revived.history()).map((m) => `${m.user}: ${m.text}`),
);

// Bring the crashed host back so there are two hosts to hand off BETWEEN.
if (!hostA) hostA = startRoomHost('host-a@chat', hub.transport(), store);
else hostB = startRoomHost('host-b@chat', hub.transport(), store);
await settle();
await revived.say('ada', 'anyone around for a graceful drain demo?');
const liveOwner = gw1.whereis('rooms', 'lobby');
console.log(
  `\n--- ${liveOwner} DRAINS gracefully (planned) — it hands #lobby off BEFORE leaving ---`,
);
const draining = liveOwner === 'host-a@chat' ? hostA : hostB;
await draining.drain();
if (liveOwner === 'host-a@chat') hostA = null as never;
else hostB = null as never;
await settle(); // registry gossip settles on the successor

// No client reconnect, no cold start: the room is ALREADY registered on the successor, pre-warmed
// and rehydrated by the drain. whereis points at the new host and history is intact.
const newOwner = gw1.whereis('rooms', 'lobby');
console.log('#lobby now lives on:', newOwner, '(pre-warmed by the handoff — no cold miss)');
console.log(
  'history intact after handoff:',
  (await chat(gw2, 'lobby').history()).map((m) => `${m.user}: ${m.text}`),
);

if (hostA) await hostA.stop();
if (hostB) await hostB.stop();
gw1.stop();
gw2.stop();
