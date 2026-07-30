/**
 * `Presence` — Elixir's **`Phoenix.Presence`** / `Phoenix.Tracker`: track who (or what) is present
 * on a topic across the whole cluster, converging without coordination. "Who's in this room", "who
 * is online", "who's viewing this document" — the canonical real-time feature.
 *
 * Phoenix.Tracker is an **ORSWOT delta-CRDT with anti-entropy** — which is exactly the
 * `ORSet`/`Node` machinery already proven here under 40% frame loss — so Presence is a thin layer
 * over it, not a new distributed system. Each `track` is a replicated fact `presence…topic…key…
 * presenceId…meta`; it converges cluster-wide and, like any registration, is **hidden when its
 * owning node goes down** and reappears if it returns (liveness is intersected on read, so a
 * transient netsplit doesn't wipe presences — it just hides the unreachable side). Multiple tracks
 * of the same key (a user with two tabs) show as multiple `metas`, exactly like Phoenix.
 *
 * With a {@link PubSub} passed in, `track`/`untrack`/`update` also emit a `presence_diff` so
 * subscribers get immediate join/leave deltas; `list` always reflects the converged CRDT truth.
 *
 * ```ts
 * import { Node, memoryHub } from '../node/index.ts';
 * const node = Node.start('n@pr', memoryHub().transport());
 * const pr = presence(node);
 * pr.track('room:lobby', 'ada', { typing: false });
 * pr.list('room:lobby'); // { ada: { metas: [ { typing: false } ] } }
 * node.stop();
 * ```
 */
import type { NodeHandle } from '../node/index.ts';
import type { PubSub } from '../pubsub/index.ts';

/** Arbitrary presence metadata for one tracked entry (a device, a cursor colour, a status). */
export type Meta = Record<string, unknown>;
/** The presences on a topic: each key with its list of metas (one per tracked connection). */
export type PresenceList = Record<string, { metas: Meta[] }>;
/** A join/leave delta for a topic — the shape emitted on `presence_diff`. */
export interface PresenceDiff {
  /** Entries that appeared since the last diff. */
  joins: { key: string; meta: Meta }[];
  /** Entries that went away since the last diff. */
  leaves: { key: string; meta: Meta }[];
}

/** A running presence tracker over a node — see {@link presence}. */
export interface Presence {
  /** Track this node's presence for `key` on `topic`; returns an untrack for this exact entry. */
  track(topic: string, key: string, meta?: Meta): () => void;
  /** Remove all of THIS node's presences for `key` on `topic`. */
  untrack(topic: string, key: string): void;
  /** Replace the meta of THIS node's presences for `key` on `topic`. */
  update(topic: string, key: string, meta: Meta): void;
  /** Everyone present on `topic` right now (converged, downed nodes hidden). */
  list(topic: string): PresenceList;
  /** Subscribe to join/leave diffs for `topic` (requires a PubSub); returns an unsubscribe. */
  subscribe(topic: string, handler: (diff: PresenceDiff) => void): () => void;
}

const SEP = '\u001f'; // unit separator — cannot appear in a topic/key/JSON meta, so parts never collide
const factPrefix = (topic: string) => `presence${SEP}${topic}${SEP}`;
const diffTopic = (topic: string) => `presence_diff${SEP}${topic}`;
const ownerOf = (presenceId: string) => presenceId.slice(0, presenceId.lastIndexOf(':'));

/**
 * Build a {@link Presence} tracker over `node`. Pass a {@link PubSub} to get live `presence_diff`
 * broadcasts (and `subscribe`); without one, `list` still works (poll the converged state).
 *
 * ```ts
 * import { Node, memoryHub } from '../node/index.ts';
 * const node = Node.start('n@pr2', memoryHub().transport());
 * const pr = presence(node);
 * const off = pr.track('game:1', 'p1', { score: 0 });
 * off(); // untrack
 * pr.list('game:1'); // {}
 * node.stop();
 * ```
 */
export function presence(node: NodeHandle, bus?: PubSub): Presence {
  let counter = 0;
  // My own live presences, so untrack/update can drop the EXACT fact strings I put.
  const mine = new Map<string, { topic: string; key: string; presenceId: string; fact: string }>();

  const makeFact = (topic: string, key: string, presenceId: string, meta: Meta): string =>
    `${factPrefix(topic)}${key}${SEP}${presenceId}${SEP}${JSON.stringify(meta)}`;
  const mineKey = (topic: string, key: string, presenceId: string) =>
    `${topic}${SEP}${key}${SEP}${presenceId}`;

  const isLive = (owner: string): boolean => owner === node.self() || node.list().includes(owner);

  const emit = (
    topic: string,
    joins: PresenceDiff['joins'],
    leaves: PresenceDiff['leaves'],
  ): void =>
    void bus?.broadcast(diffTopic(topic), 'presence_diff', {
      joins,
      leaves,
    } satisfies PresenceDiff);

  return {
    track(topic, key, meta = {}) {
      const presenceId = `${node.self()}:${++counter}`;
      const fact = makeFact(topic, key, presenceId, meta);
      node.putFact(fact);
      const mk = mineKey(topic, key, presenceId);
      mine.set(mk, { topic, key, presenceId, fact });
      emit(topic, [{ key, meta }], []);
      return () => {
        const entry = mine.get(mk);
        if (!entry) return;
        node.dropFact(entry.fact);
        mine.delete(mk);
        emit(topic, [], [{ key, meta }]);
      };
    },
    untrack(topic, key) {
      for (const [mk, entry] of [...mine]) {
        if (entry.topic !== topic || entry.key !== key) continue;
        node.dropFact(entry.fact);
        mine.delete(mk);
        emit(topic, [], [{ key, meta: {} }]);
      }
    },
    update(topic, key, meta) {
      for (const [mk, entry] of [...mine]) {
        if (entry.topic !== topic || entry.key !== key) continue;
        node.dropFact(entry.fact); // observed-remove the old fact...
        const fact = makeFact(topic, key, entry.presenceId, meta);
        node.putFact(fact); // ...and add the new one (same presenceId = same identity)
        mine.set(mk, { ...entry, fact });
        emit(topic, [{ key, meta }], []);
      }
    },
    list(topic) {
      const out: PresenceList = {};
      const prefix = factPrefix(topic);
      for (const fact of node.facts(prefix)) {
        const [key, presenceId, metaJSON] = fact.slice(prefix.length).split(SEP);
        if (!isLive(ownerOf(presenceId))) continue; // hide presences on a downed node
        (out[key] ??= { metas: [] }).metas.push(JSON.parse(metaJSON) as Meta);
      }
      return out;
    },
    subscribe(topic, handler) {
      if (!bus)
        throw new Error('presence.subscribe needs a PubSub — pass one to presence(node, bus)');
      return bus.subscribe(diffTopic(topic), (_event, payload) => handler(payload as PresenceDiff));
    },
  };
}
