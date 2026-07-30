/**
 * `PubSub` — Elixir's **`Phoenix.PubSub`**: cluster-wide topic pub/sub. Any handler `subscribe`s
 * to a topic; a `broadcast` on any node reaches every subscriber on every node. It's the real-time
 * backbone under Channels and Presence, and the messaging layer for anything fan-out (live
 * dashboards, notifications, "someone changed X").
 *
 * It rides the CRDT-backed process groups directly — `Phoenix.PubSub` is itself implemented on
 * `pg`, and so is this: a node with a local subscriber for a topic joins that topic's group, and a
 * `broadcast` is a group cast that fans out to exactly the nodes that have subscribers, each of
 * which dispatches to its local handlers. Cross-node delivery therefore inherits the group
 * membership's gossip latency (a just-subscribed remote node converges in the usual anti-entropy
 * window); same-node delivery is immediate.
 *
 * ```ts
 * import { Node, memoryHub } from '../node/index.ts';
 * const node = Node.start('n@ps', memoryHub().transport());
 * const ps = pubsub(node);
 * const got: string[] = [];
 * ps.subscribe('news', (event, payload) => got.push(`${event}:${payload}`));
 * ps.broadcast('news', 'headline', 'hello');
 * await new Promise((r) => setTimeout(r, 10));
 * got; // ['headline:hello']
 * node.stop();
 * ```
 */
import type { NodeHandle } from '../node/index.ts';

/** A local subscriber — invoked with the broadcast's event name and payload. */
export type PubSubHandler = (event: string, payload: unknown) => void;

/** A running pub/sub facade over a node — see {@link pubsub}. */
export interface PubSub {
  /** Subscribe `handler` to `topic` on this node; returns an unsubscribe. */
  subscribe(topic: string, handler: PubSubHandler): () => void;
  /** Remove one subscription. */
  unsubscribe(topic: string, handler: PubSubHandler): void;
  /** Broadcast to every subscriber of `topic` cluster-wide, THIS node included. */
  broadcast(topic: string, event: string, payload?: unknown): void;
  /** Broadcast to every subscriber EXCEPT this node's — Phoenix's `broadcast_from`. */
  broadcastFrom(topic: string, event: string, payload?: unknown): void;
}

const SUBJECT = 'pubsub.msg';
const groupOf = (topic: string) => `pubsub${topic}`;

/**
 * Build a {@link PubSub} facade over `node`. One per node (it registers the node's `pubsub.msg`
 * handler); pass the same instance to Channels and Presence so they share the fan-out.
 *
 * ```ts
 * import { Node, memoryHub } from '../node/index.ts';
 * const node = Node.start('n@ps2', memoryHub().transport());
 * typeof pubsub(node).broadcast; // 'function'
 * node.stop();
 * ```
 */
export function pubsub(node: NodeHandle): PubSub {
  const local = new Map<string, Set<PubSubHandler>>();

  node.handle(SUBJECT, (raw) => {
    const msg = raw as { topic: string; event: string; payload: unknown; except?: string };
    if (msg.except !== undefined && msg.except === node.self()) return; // broadcast_from skips origin
    const subs = local.get(msg.topic);
    if (subs) for (const handler of [...subs]) handler(msg.event, msg.payload);
  });

  const cast = (topic: string, event: string, payload: unknown, except?: string): void =>
    node.cast(`group:${groupOf(topic)}`, SUBJECT, { topic, event, payload, except });

  const unsubscribe = (topic: string, handler: PubSubHandler): void => {
    const subs = local.get(topic);
    if (!subs) return;
    subs.delete(handler);
    if (subs.size === 0) {
      local.delete(topic);
      node.leave(groupOf(topic)); // last local subscriber gone — leave the topic's group
    }
  };

  return {
    subscribe(topic, handler) {
      let subs = local.get(topic);
      if (!subs) {
        subs = new Set();
        local.set(topic, subs);
        node.join(groupOf(topic)); // first local subscriber — join so broadcasts reach us
      }
      subs.add(handler);
      return () => unsubscribe(topic, handler);
    },
    unsubscribe,
    broadcast: (topic, event, payload) => cast(topic, event, payload),
    broadcastFrom: (topic, event, payload) => cast(topic, event, payload, node.self()),
  };
}
