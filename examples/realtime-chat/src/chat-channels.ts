// The REALTIME edge of the chat, dogfooding the new stack end to end: Phoenix Channels for the
// client connection, Presence for who's-in-the-room, and PubSub to fan a message out to everyone
// joined — layered on top of the SAME durable room actors the rest of the example uses (the room
// is still a `serve()` unit behind the `rooms` Registry, so history stays persisted + handoff-safe).
//
// A browser connects a `channelClient` to a gateway running this `chatGateway`, joins `room:<key>`,
// and sends `message` events; the gateway appends to the durable room actor and broadcasts the
// stored message to the topic, so every joined client sees it. Join/leave update Presence.
import * as Node from '../../../lib/node/index.ts';
import { rendezvous } from '../../../lib/node/index.ts';
import { pubsub } from '../../../lib/pubsub/index.ts';
import { presence, type Presence } from '../../../lib/presence/index.ts';
import { channelServer, type Socket, type Connection } from '../../../lib/channel/index.ts';
import type { NodeHandle } from '../../../lib/node/index.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keyOf = (topic: string) => topic.slice('room:'.length);

// Find-or-start a room on its rendezvous host, idempotently (mirrors chat-client's cold path).
async function ensureRoom(node: NodeHandle, key: string): Promise<void> {
  if (node.whereis('rooms', key)) return;
  const host = rendezvous(key, node.groupMembers('room-hosts'));
  if (!host) return;
  await node.call(host, 'host.ensureRoom', { key });
  for (let i = 0; i < 100 && !node.whereis('rooms', key); i++) await sleep(5);
}

export interface ChatGateway {
  /** Attach a client socket; it can then join room topics and send messages. */
  connect(socket: Socket): Connection;
  /** The gateway's presence tracker — `list('room:<key>')` is who's in that room. */
  presence: Presence;
}

/**
 * Build a channel-based chat gateway on `gateway`. Clients join `room:<key>` (Presence-tracked) and
 * send `message` events; each is appended to the durable room actor and broadcast to the topic.
 */
export function chatGateway(gateway: NodeHandle): ChatGateway {
  const bus = pubsub(gateway);
  const pres = presence(gateway, bus);

  const server = channelServer(gateway, bus, {
    join(topic, payload, socket) {
      if (!topic.startsWith('room:')) return { error: 'unknown topic' };
      void ensureRoom(gateway, keyOf(topic)); // warm the room; the message path re-ensures anyway
      pres.track(topic, socket.id, { user: (payload as { user?: string })?.user ?? 'anon' });
      return { ok: true };
    },
    handleIn(topic, event, payload, socket) {
      const key = keyOf(topic);
      if (event === 'message') {
        // Append to the durable room actor (persist-before-ack), THEN broadcast the stored
        // message to every joined client. Fire-and-forget: the message arrives as a push, not a
        // synchronous reply — the natural chat flow.
        void (async () => {
          await ensureRoom(gateway, key);
          const msg = await gateway.call(`via:rooms/${key}`, `room:${key}.message`, payload);
          bus.broadcast(topic, 'message', msg);
        })().catch(() => {});
      } else if (event === 'presence') {
        return { reply: pres.list(topic) }; // who's in the room, from the CRDT tracker
      } else if (event === 'leave') {
        pres.untrack(topic, socket.id);
      }
    },
  });

  return { connect: (socket) => server.connect(socket), presence: pres };
}

// Re-export so a demo can spin up the durable room hosts this gateway talks to.
export { startRoomHost } from './room-host.ts';
export const memoryStore = Node.memoryStore;
