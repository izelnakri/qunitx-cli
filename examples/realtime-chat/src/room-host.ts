// A room-host node — where rooms actually live. It joins the 'room-hosts' group (so gateways
// can find hosts) and owns a DynamicSupervisor that spawns one supervised room actor per key
// on demand, registering each in the 'rooms' Registry so it is addressable cluster-wide.
//
// This is the canonical OTP pair:  DynamicSupervisor.start_child  +  Registry.register.
import * as Node from '../../../lib/node/index.ts';
import * as Supervisor from '../../../lib/supervisor/index.ts';
import { makeRoomBehavior } from './room-behavior.ts';
import type { Transport, NodeHandle } from '../../../lib/node/index.ts';

export type RoomHost = { node: NodeHandle; stop: () => Promise<void> };

export function startRoomHost(name: string, transport: Transport): RoomHost {
  const node = Node.start(name, transport);
  node.join('room-hosts');

  const rooms = Supervisor.dynamic({ maxRestarts: 50, maxSeconds: 10 });
  const served = new Map<string, ReturnType<typeof Node.serve>>();

  // find-or-start, LOCAL and therefore race-free: gateways route every "ensure lobby" to the
  // SAME host (deterministic hash — see chat-client.ts), so this check serialises on one node.
  node.handle('host.ensureRoom', (payload) => {
    const key = (payload as { key: string }).key;
    if (served.has(key)) return name; // already live here
    rooms.startChild({
      id: `room:${key}`,
      restart: 'transient', // a crash restarts it; a clean exit (empty room) does not
      start: (signal) => runRoom(node, key, served, signal),
    });
    return name; // the owner node
  });

  // Close an empty room — DynamicSupervisor.terminate_child + Registry.unregister, the mirror
  // of spawn. Called by a gateway when the last member leaves.
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

// One room's lifecycle: register the key, serve the actor, and — because restart is 'transient'
// — resolve (a clean exit → no restart) when the supervisor aborts it, unregistering on the way
// out. A crash (thrown) would instead restart it, fresh, still registered under the same key.
function runRoom(
  node: NodeHandle,
  key: string,
  served: Map<string, ReturnType<typeof Node.serve>>,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((exited) => {
    node.register('rooms', key); // now addressable as via:rooms/<key> from any node
    served.set(key, Node.serve(node, `room:${key}`, makeRoomBehavior(), { maxMailbox: 256 }));
    signal.addEventListener('abort', () => {
      node.unregister('rooms', key);
      served.delete(key);
      exited();
    });
  });
}
