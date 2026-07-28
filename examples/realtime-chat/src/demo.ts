// A runnable, self-contained demo — two room hosts and two gateway nodes in ONE process over
// an in-process hub (so `node src/demo.ts` just works). In production the hosts and gateways
// are separate pods over a real hub (wsTransport); the code below is identical either way.
import * as Node from '../../../lib/node/index.ts';
import { startRoomHost } from './room-host.ts';
import { chat } from './chat-client.ts';

const settle = () => new Promise((r) => setTimeout(r, 30));
const hub = Node.memoryHub();

// The cluster: 2 room hosts (where rooms live) + 2 gateways (where users connect).
const hostA = startRoomHost('host-a@chat', hub.transport());
const hostB = startRoomHost('host-b@chat', hub.transport());
const gw1 = Node.start('gw1@chat', hub.transport());
const gw2 = Node.start('gw2@chat', hub.transport());
await settle(); // hellos + group membership propagate

console.log('--- ada joins #lobby from gateway 1; bo joins the SAME room from gateway 2 ---');
const adaLobby = chat(gw1, 'lobby');
const boLobby = chat(gw2, 'lobby');
await adaLobby.join('ada'); // cold: find-or-start spawns the room on one host, registers it
const boView = await boLobby.join('bo'); // hot: the Registry already knows where #lobby lives
console.log('bo sees members:', boView.members);
console.log(
  '#lobby lives on:',
  gw1.whereis('rooms', 'lobby'),
  '(both gateways agree:',
  gw2.whereis('rooms', 'lobby') + ')',
);

await adaLobby.say('ada', 'hi bo 👋');
await boLobby.say('bo', 'hey ada');
console.log(
  'shared history (one actor, serialized):',
  (await adaLobby.history()).map((m) => `${m.user}: ${m.text}`),
);

console.log('\n--- a different room hashes to a (maybe) different host ---');
await chat(gw1, 'random').join('cy');
console.log('#lobby  →', gw1.whereis('rooms', 'lobby'));
console.log('#random →', gw1.whereis('rooms', 'random'));

console.log('\n--- everyone leaves #lobby → the room is GC-ed (terminateChild + unregister) ---');
await adaLobby.leave('ada');
await boLobby.leave('bo');
await settle();
console.log('#lobby owner after empty:', gw1.whereis('rooms', 'lobby'), '(null = reaped)');

await hostA.stop();
await hostB.stop();
gw1.stop();
gw2.stop();
