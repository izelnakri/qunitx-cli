/**
 * `Channel` — Elixir's **Phoenix Channels**: the client-facing real-time layer. A client connects
 * to a gateway node over a {@link Socket}, `join`s topics, sends events, and receives pushes; the
 * server authorizes joins, handles inbound events, and `broadcast`s to every client subscribed to
 * a topic — **across the whole cluster**, because broadcasts ride {@link PubSub}. This is the
 * Phoenix Channels + Socket shape (chat, live views, multiplayer) on web-standard transports.
 *
 * The core is transport-agnostic: a {@link Socket} is anything that can `push` to one client
 * (a WebSocket in production, an in-memory object in tests). The server maps each topic to the
 * local sockets joined to it and subscribes the node to that topic once; a broadcast fans out via
 * PubSub to every node with subscribers, and each pushes to its local sockets — so one
 * `broadcast` reaches a client on any node, and the sender's own clients included (Phoenix
 * semantics). Pair it with {@link Presence} to track who's in each topic.
 *
 * ```ts
 * import { start, memoryHub } from '../node/index.ts';
 * import { pubsub } from '../pubsub/index.ts';
 * const node = start('gw@ch', memoryHub().transport());
 * const server = channelServer(node, pubsub(node), {
 *   handleIn: (topic, event, payload) => ({ reply: { echoed: payload } }),
 * });
 * const got: unknown[] = [];
 * const conn = server.connect({ id: 'c1', push: (t, e, p) => got.push([t, e, p]) });
 * conn.join('room:1');
 * conn.broadcast('room:1', 'msg', 'hi');
 * await new Promise((r) => setTimeout(r, 10));
 * got; // [['room:1', 'msg', 'hi']]
 * node.stop();
 * ```
 */
import type { NodeHandle } from '../node/index.ts';
import type { PubSub } from '../pubsub/index.ts';

/** One client connection, from the server's side — how it pushes messages down to that client. */
export interface Socket {
  /** A stable id for this connection (used to de-dupe and route). */
  readonly id: string;
  /** Push a message to the client on `topic`. */
  push(topic: string, event: string, payload?: unknown): void;
}

/** The result of a join attempt — authorize with `ok`, deny with `error`. */
export type JoinResult = { ok: true; response?: unknown } | { error: unknown };

/** The server-side behavior of a channel — Phoenix's `join`/`handle_in`. */
export interface ChannelDef {
  /** Authorize a client joining `topic`. Omit to allow all joins. */
  join?(topic: string, payload: unknown, socket: Socket): JoinResult;
  /** Handle an inbound client event; return `{ reply }` to answer that client. */
  handleIn?(
    topic: string,
    event: string,
    payload: unknown,
    socket: Socket,
  ): { reply?: unknown } | void;
}

/** One client's live connection to the channel server — see {@link ChannelServer.connect}. */
export interface Connection {
  /** Join `topic` (runs the server's `join` authorizer); the socket then receives its broadcasts. */
  join(topic: string, payload?: unknown): JoinResult;
  /** Send an inbound event on `topic` (runs `handleIn`); returns its optional reply. */
  push(topic: string, event: string, payload?: unknown): { reply?: unknown } | void;
  /** Leave `topic` — stop receiving its broadcasts. */
  leave(topic: string): void;
  /** Broadcast to every client subscribed to `topic` cluster-wide (this client included). */
  broadcast(topic: string, event: string, payload?: unknown): void;
  /** Disconnect — leave every joined topic. */
  disconnect(): void;
}

/** A running channel server on a gateway node — see {@link channelServer}. */
export interface ChannelServer {
  /** Attach a newly-connected client socket; returns its {@link Connection}. */
  connect(socket: Socket): Connection;
}

/**
 * Build a {@link ChannelServer} on `node`, fanning out over `bus`. `def` supplies the server-side
 * `join`/`handleIn` behavior.
 *
 * ```ts
 * import { start, memoryHub } from '../node/index.ts';
 * import { pubsub } from '../pubsub/index.ts';
 * const node = start('gw@ch2', memoryHub().transport());
 * const server = channelServer(node, pubsub(node), {
 *   join: (topic) => (topic === 'room:public' ? { ok: true } : { error: 'forbidden' }),
 * });
 * server.connect({ id: 'c', push: () => {} }).join('room:public'); // { ok: true }
 * node.stop();
 * ```
 */
export function channelServer(node: NodeHandle, bus: PubSub, def: ChannelDef): ChannelServer {
  void node; // reserved: server-initiated pushes / node-scoped state hang off the node
  // Local sockets joined to each topic, and the single node-level PubSub subscription per topic.
  const topicSockets = new Map<string, Set<Socket>>();
  const topicOff = new Map<string, () => void>();

  const subscribeTopic = (topic: string): void => {
    if (topicSockets.has(topic)) return;
    topicSockets.set(topic, new Set());
    // One node subscription per topic; the handler pushes to every local socket joined to it.
    topicOff.set(
      topic,
      bus.subscribe(topic, (event, payload) => {
        for (const socket of topicSockets.get(topic) ?? []) socket.push(topic, event, payload);
      }),
    );
  };

  const leaveTopic = (topic: string, socket: Socket): void => {
    const sockets = topicSockets.get(topic);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) {
      topicOff.get(topic)?.();
      topicOff.delete(topic);
      topicSockets.delete(topic);
    }
  };

  return {
    connect(socket) {
      const joined = new Set<string>();
      return {
        join(topic, payload) {
          const result = def.join ? def.join(topic, payload, socket) : { ok: true as const };
          if ('ok' in result) {
            subscribeTopic(topic);
            topicSockets.get(topic)!.add(socket);
            joined.add(topic);
          }
          return result;
        },
        push(topic, event, payload) {
          return def.handleIn?.(topic, event, payload, socket);
        },
        leave(topic) {
          joined.delete(topic);
          leaveTopic(topic, socket);
        },
        broadcast(topic, event, payload) {
          bus.broadcast(topic, event, payload); // fans out to all nodes → local sockets everywhere
        },
        disconnect() {
          for (const topic of [...joined]) leaveTopic(topic, socket);
          joined.clear();
        },
      };
    },
  };
}
