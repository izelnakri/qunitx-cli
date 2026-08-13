// A room-host node — where rooms live. It joins 'room-hosts' (so gateways find hosts via
// rendezvous hashing) and owns a DynamicSupervisor that spawns one supervised, DURABLE room
// actor per key on demand, registering each in the 'rooms' Registry.
//
// The pair:  DynamicSupervisor.start_child  +  Registry.register  +  a shared Store.
// The Store is what makes a room survive its host dying: the next owner rehydrates from it.
import * as Node from '../../../lib/node/index.ts';
import { rendezvous } from '../../../lib/node/index.ts';
import * as Supervisor from '../../../lib/supervisor/index.ts';
import { makeRoomBehavior } from './room-behavior.ts';
import type { Transport, NodeHandle, Store } from '../../../lib/node/index.ts';

export type RoomHost = {
  node: NodeHandle;
  /** Hard stop — a crash. Rooms vanish from memory; a survivor cold-rehydrates on next access. */
  stop: () => Promise<void>;
  /** Graceful drain — hand each room off to its successor host BEFORE leaving (no cold miss). */
  drain: () => Promise<void>;
};

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

  // Rebalance on scale-UP — the other half of Horde.DynamicSupervisor's redistribution (drain is
  // scale-down). When a new host joins (Erlang nodeup), any room whose rendezvous owner is now the
  // newcomer is handed off to it, so the keyspace re-spreads as the cluster grows — HRW moves only
  // ~1/N of each host's rooms, not the whole keyspace. Same re-home-by-key as drain: release first,
  // then pre-warm, so the split-brain guard can't tear the fresh room down.
  node.monitorNodes(async ({ node: peer, status }) => {
    if (status !== 'up') return;
    // Wait (bounded) for the newcomer's 'room-hosts' membership to converge before deciding.
    for (let i = 0; i < 50 && !node.groupMembers('room-hosts').includes(peer); i++)
      await new Promise((r) => setTimeout(r, 5));
    const hosts = node.groupMembers('room-hosts');
    if (!hosts.includes(peer)) return; // the newcomer is a gateway, not a host — nothing to hand off
    for (const key of [...live]) {
      if (rendezvous(key, hosts) !== peer) continue;
      await rooms.terminateChild(`room:${key}`); // release: the room exits + unregisters
      await node.call(peer, 'host.ensureRoom', { key }); // pre-warm the newcomer
    }
  });

  return {
    node,
    stop: async () => {
      await rooms.stop();
      node.stop();
    },
    // Horde.DynamicSupervisor's graceful hand-off: on a planned drain, redistribute every room
    // I own to the host that rendezvous now picks among the OTHERS, so the room is already live
    // and rehydrated when I leave — no first-access cold start for the next caller.
    //
    // Re-home BY KEY: release my ownership FIRST, then pre-warm the successor. Releasing first is
    // deliberate — starting the room on the successor while I still own the key would trip the
    // split-brain guard (smallest name wins), which could tear the fresh room right back down.
    //
    // Divergence from Horde, which streams a child's LIVE process state to the new node: we
    // re-home by key and rehydrate from the SHARED store. persist-before-ack already made every
    // committed change durable, so the store IS the handoff channel — no bespoke state transfer,
    // and it doubles as crash recovery. The cost is a rehydrate read per room (README §5).
    drain: async () => {
      const others = node.groupMembers('room-hosts').filter((host) => host !== name);
      for (const key of [...live]) {
        await rooms.terminateChild(`room:${key}`); // release: the room exits + unregisters
        const next = rendezvous(key, others);
        if (next) await node.call(next, 'host.ensureRoom', { key }); // pre-warm the successor
      }
      await rooms.stop();
      node.stop();
    },
  };
}

// One room's lifecycle. `via` ties the Registry entry to the unit: it registers on start,
// unregisters on exit, AND self-terminates if a smaller-named host wins the same key (so a
// split-brain during a partition heals to one owner). `store` rehydrates state on start and
// persists every change before ack. A transient exit (empty-room close) does not restart.
function runRoom(
  node: NodeHandle,
  key: string,
  store: Store,
  live: Set<string>,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((exited) => {
    // storeKey is stable across hosts, so a room re-created on ANOTHER host loads the same state.
    const room = Node.genServer(node, `room:${key}`, makeRoomBehavior(), {
      via: { registry: 'rooms', key },
      store,
      storeKey: `room:${key}`,
      maxMailbox: 256,
    });
    signal.addEventListener('abort', () => {
      room.exit(); // unregisters via the Registry
      live.delete(key);
      exited();
    });
  });
}
