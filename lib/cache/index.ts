// Barrel for the Cache leg: import { distributedCache } from '.../lib/cache/index.ts'.
//
// A cluster-coherent cache with no central Redis: an LWWMap CRDT gossiped over PubSub, so a set
// or an invalidation on any node converges everywhere, last-writer-wins resolves races, and reads
// are local + O(1) with an optional per-entry TTL. Eventual consistency by design — for a strongly
// consistent value, read its owning actor via `via:`, not the cache.
export { distributedCache, type DistributedCache } from './cache.ts';
