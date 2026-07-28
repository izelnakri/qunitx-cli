/**
 * `distributedCache` — a cache **coherent across the cluster**, no central Redis. A per-node
 * `Map` caches independently, so invalidating a key on one node leaves the others serving stale;
 * this backs the cache with the {@link LWWMap} CRDT and gossips writes over {@link PubSub}, so a
 * `set` or a `delete` (invalidation) on ANY node **converges everywhere**, and last-writer-wins
 * resolves concurrent updates deterministically. Reads are local and O(1); an optional per-entry
 * TTL expires locally on read.
 *
 * The trade is the CRDT's: eventual consistency (a write is visible cluster-wide within the gossip
 * window, immediately on the writing node) and last-writer-wins on conflict (fine for a cache —
 * the worst case is a briefly-stale read, which a cache tolerates by definition). For a value that
 * must be strongly consistent, read it from its owning actor (`via:`), not the cache.
 *
 * ```ts
 * import { start, memoryHub } from '../node/index.ts';
 * import { pubsub } from '../pubsub/index.ts';
 * const hub = memoryHub();
 * const a = start('a@cache', hub.transport());
 * const b = start('b@cache', hub.transport());
 * const cacheA = distributedCache<number>(a, pubsub(a));
 * const cacheB = distributedCache<number>(b, pubsub(b));
 * cacheA.set('hits', 41);
 * await new Promise((r) => setTimeout(r, 30)); // gossip settles
 * cacheB.get('hits'); // 41 — the write converged to node B
 * a.stop();
 * b.stop();
 * ```
 */
import { LWWMap } from '../node/counters.ts';
import type { NodeHandle } from '../node/node.ts';
import type { PubSub } from '../pubsub/pubsub.ts';

/** A cluster-coherent cache over a node — see {@link distributedCache}. */
export interface DistributedCache<V> {
  /** The value for `key`, or `undefined` if unset, deleted, or expired. */
  get(key: string): V | undefined;
  /** Set `key` and gossip it; `at` (default now) is the LWW timestamp. */
  set(key: string, value: V, at?: number): void;
  /** Invalidate `key` cluster-wide — a CRDT tombstone that converges as a removal. */
  delete(key: string, at?: number): void;
  /** The live (non-deleted, non-expired) keys currently known here. */
  keys(): string[];
}

// The wrapped value: a tombstone (`del`) or a value with an optional local expiry.
interface Entry<V> {
  v?: V;
  exp?: number;
  del?: boolean;
}

/**
 * Build a {@link DistributedCache} over `node`, gossiping on `bus`. `topic` is the PubSub topic
 * (default `'cache'` — use distinct topics for distinct caches); `ttlMs`, if set, is the default
 * per-entry lifetime (each node expires on read).
 *
 * ```ts
 * import { start, memoryHub } from '../node/index.ts';
 * import { pubsub } from '../pubsub/index.ts';
 * const node = start('n@c', memoryHub().transport());
 * const cache = distributedCache<string>(node, pubsub(node), { ttlMs: 60000 });
 * cache.set('greeting', 'hi');
 * cache.get('greeting'); // 'hi'
 * node.stop();
 * ```
 */
export function distributedCache<V>(
  node: NodeHandle,
  bus: PubSub,
  options: { topic?: string; ttlMs?: number } = {},
): DistributedCache<V> {
  const topic = options.topic ?? 'cache';
  const map = new LWWMap<Entry<V>>(node.self());
  bus.subscribe(topic, (_event, delta) => map.merge(delta as Record<string, never>));

  const gossip = (key: string): void => {
    const state = map.state();
    if (state[key]) bus.broadcast(topic, 'set', { [key]: state[key] }); // a one-entry LWW delta
  };
  const live = (entry: Entry<V> | undefined): boolean =>
    entry !== undefined && !entry.del && !(entry.exp !== undefined && Date.now() > entry.exp);

  return {
    get(key) {
      const entry = map.get(key);
      return live(entry) ? entry!.v : undefined;
    },
    set(key, value, at) {
      map.set(key, { v: value, exp: options.ttlMs ? Date.now() + options.ttlMs : undefined }, at);
      gossip(key);
    },
    delete(key, at) {
      map.set(key, { del: true }, at ?? Date.now());
      gossip(key);
    },
    keys() {
      return map.keys().filter((key) => live(map.get(key)));
    },
  };
}
