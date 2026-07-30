/**
 * `shardedPresence` — a **partitioned** presence tracker, the counterpart to the fully-replicated
 * {@link presence}. Replicated presence is simple and converges everywhere, but every node holds
 * every entry (it shares the registry's O(entries) ceiling — the frontier #1 names). This shards
 * instead: each topic's presence lives on ONE **coordinator** node, chosen by rendezvous hashing,
 * so a node only holds the topics it coordinates and memory scales with the cluster. It's the first
 * concrete consumer of the sharded-registry idea, scoped to presence.
 *
 * `track`/`untrack`/`list` route to the topic's coordinator (so they're async — the sharding cost
 * is a hop, versus replicated presence's local read). Two mechanisms keep it correct as membership
 * changes: an owner going down has its entries **pruned** by the coordinator (liveness), and when a
 * topic's coordinator moves (a node joins/leaves and rendezvous re-picks), each owner **re-homes**
 * its own tracks to the new coordinator — so presence follows the shard.
 *
 * ```ts
 * import { Node, memoryHub } from '../node/index.ts';
 * const hub = memoryHub();
 * const a = Node.start('a@sp', hub.transport());
 * const b = Node.start('b@sp', hub.transport());
 * await new Promise((r) => setTimeout(r, 40));
 * await shardedPresence(a).track('room:1', 'ada', { role: 'host' });
 * await new Promise((r) => setTimeout(r, 40));
 * await shardedPresence(b).list('room:1'); // { ada: { metas: [ { role: 'host' } ] } }
 * a.stop();
 * b.stop();
 * ```
 */
import { rendezvous } from '../node/index.ts';
import type { NodeHandle } from '../node/index.ts';
import type { Meta, PresenceList } from './presence.ts';

const TRACK = 'sharded-presence.track';
const UNTRACK = 'sharded-presence.untrack';
const LIST = 'sharded-presence.list';

interface Entry {
  owner: string;
  key: string;
  meta: Meta;
}

/** A partitioned presence tracker over a node — see {@link shardedPresence}. */
export interface ShardedPresence {
  /** Track this node's presence for `key` on `topic` (routes to the coordinator); returns untrack. */
  track(topic: string, key: string, meta?: Meta): Promise<() => void>;
  /** Remove all of this node's presences for `key` on `topic`. */
  untrack(topic: string, key: string): Promise<void>;
  /** Everyone present on `topic` right now (queried from its coordinator). */
  list(topic: string): Promise<PresenceList>;
}

/**
 * Build a {@link ShardedPresence} over `node`. `peers()` is the coordinator set (default: this
 * node plus its live peers); rendezvous over it picks each topic's coordinator.
 *
 * ```ts
 * import { Node, memoryHub } from '../node/index.ts';
 * const node = Node.start('solo@sp', memoryHub().transport());
 * await shardedPresence(node).track('t', 'k', { a: 1 });
 * await shardedPresence(node).list('t'); // { k: { metas: [ { a: 1 } ] } }
 * node.stop();
 * ```
 */
export function shardedPresence(
  node: NodeHandle,
  options: { peers?: () => string[] } = {},
): ShardedPresence {
  const self = node.self();
  let counter = 0;
  const roster = options.peers ?? (() => [self, ...node.list()]);
  const coordinatorOf = (topic: string): string => rendezvous(topic, roster()) ?? self;

  // Coordinator-side shard state: topic -> presenceId -> entry. Only for topics I coordinate.
  const shard = new Map<string, Map<string, Entry>>();
  const put = (topic: string, id: string, entry: Entry): void =>
    void (shard.get(topic) ?? shard.set(topic, new Map()).get(topic)!).set(id, entry);
  const drop = (topic: string, id: string): void => void shard.get(topic)?.delete(id);
  const listLocal = (topic: string): PresenceList => {
    const out: PresenceList = {};
    for (const { owner, key, meta } of shard.get(topic)?.values() ?? []) {
      if (owner !== self && !node.list().includes(owner)) continue; // hide a downed owner
      (out[key] ??= { metas: [] }).metas.push(meta);
    }
    return out;
  };

  node.handle(TRACK, (raw) => {
    const r = raw as { topic: string; id: string } & Entry;
    put(r.topic, r.id, { owner: r.owner, key: r.key, meta: r.meta });
    return true;
  });
  node.handle(
    UNTRACK,
    (raw) => void drop((raw as { topic: string }).topic, (raw as { id: string }).id),
  );
  node.handle(LIST, (raw) => listLocal((raw as { topic: string }).topic));

  // Liveness: when a peer goes down, prune every presence it owned from the shards I coordinate.
  node.monitor((down) => {
    for (const entries of shard.values())
      for (const [id, e] of [...entries]) if (e.owner === down) entries.delete(id);
  });

  // My own tracks, tagged with the coordinator each was last sent to (for re-homing).
  const mine = new Map<string, { topic: string; key: string; meta: Meta; coord: string }>();

  const sendTrack = async (topic: string, id: string, key: string, meta: Meta, coord: string) => {
    if (coord === self) put(topic, id, { owner: self, key, meta });
    else await node.call(coord, TRACK, { topic, id, owner: self, key, meta });
  };
  const sendUntrack = (topic: string, id: string, coord: string): void => {
    if (coord === self) drop(topic, id);
    else node.cast(coord, UNTRACK, { topic, id });
  };

  // On any membership change, re-home each of my tracks whose coordinator moved.
  node.monitorNodes(async () => {
    for (const [id, t] of [...mine]) {
      const coord = coordinatorOf(t.topic);
      if (coord === t.coord) continue;
      sendUntrack(t.topic, id, t.coord); // best-effort removal from the old coordinator
      await sendTrack(t.topic, id, t.key, t.meta, coord);
      mine.set(id, { ...t, coord });
    }
  });

  return {
    async track(topic, key, meta = {}) {
      const id = `${self}:${++counter}`;
      const coord = coordinatorOf(topic);
      mine.set(id, { topic, key, meta, coord });
      await sendTrack(topic, id, key, meta, coord);
      return () => {
        const t = mine.get(id);
        if (!t) return;
        mine.delete(id);
        sendUntrack(topic, id, t.coord);
      };
    },
    untrack(topic, key) {
      for (const [id, t] of [...mine]) {
        if (t.topic !== topic || t.key !== key) continue;
        mine.delete(id);
        sendUntrack(topic, id, t.coord);
      }
      return Promise.resolve();
    },
    list(topic) {
      const coord = coordinatorOf(topic);
      return coord === self
        ? Promise.resolve(listLocal(topic))
        : node.call<PresenceList>(coord, LIST, { topic });
    },
  };
}
