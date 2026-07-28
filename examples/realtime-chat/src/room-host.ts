// A room-host node — where rooms live. It joins 'room-hosts' (so gateways find hosts via
// rendezvous hashing) and owns a DynamicSupervisor that spawns one supervised, DURABLE room
// actor per key on demand, registering each in the 'rooms' Registry.
//
// The pair:  DynamicSupervisor.start_child  +  Registry.register  +  a shared Store.
// The Store is what makes a room survive its host dying: the next owner rehydrates from it.
import * as Node from '../../../lib/node/index.ts';
import * as Supervisor from '../../../lib/supervisor/index.ts';
import { makeRoomBehavior } from './room-behavior.ts';
import type { Transport, NodeHandle, Store } from '../../../lib/node/index.ts';

export type RoomHost = { node: NodeHandle; stop: () => Promise<void> };

// `store` is SHARED across all hosts (a Postgres store in prod; one memoryStore in the demo to
// simulate shared durability) — that shared backend is how a room rehydrates on a new host.
export function startRoomHost(name: string, transport: Transport, store: Store): RoomHost {
  const node = Node.start(name, transport);
  node.join('room-hosts');

  const rooms = Supervisor.dynamic({ maxRestarts: 50, maxSeconds: 10 });
  const live = new Set<string>();

  // find-or-start, LOCAL and race-free: gateways rendezvous-hash every "ensure lobby" to the
  // SAME host, so this check serialises on one node.
  node.handle('host.ensureRoom', (payload) => {
    const key = (payload as { key: string }).key;
    if (live.has(key)) return name;
    live.add(key);
    rooms.startChild({
      id: `room:${key}`,
      restart: 'transient',
      start: (signal) => runRoom(node, key, store, live, signal),
    });
    return name;
  });

  node.handle('host.closeRoom', async (payload) => {
    const key = (payload as { key: string }).key;
    await rooms.terminateChild(`room:${key}`);
    return true;
  });

  return {
    node,
    stop: async () => {
      await rooms.stop();
      node.stop();
    },
  };
}

// One room's lifecycle: register the key, then serve the actor WITH THE STORE (so it rehydrates
// its members+history on start and persists every change before ack). A transient exit
// (empty-room close) unregisters and does not restart; a crash restarts it, rehydrated.
function runRoom(
  node: NodeHandle,
  key: string,
  store: Store,
  live: Set<string>,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((exited) => {
    node.register('rooms', key);
    // storeKey is stable across hosts, so a room re-created on ANOTHER host loads the same state.
    Node.serve(node, `room:${key}`, makeRoomBehavior(), {
      store,
      storeKey: `room:${key}`,
      maxMailbox: 256,
    });
    signal.addEventListener('abort', () => {
      node.unregister('rooms', key);
      live.delete(key);
      exited();
    });
  });
}
