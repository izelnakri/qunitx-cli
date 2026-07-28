// Barrel for the Presence leg: import * as Presence from '.../lib/presence/index.ts'.
//
// Elixir's Phoenix.Presence / Phoenix.Tracker — track who is present on a topic across the
// cluster, converging without coordination. Built directly on the ORSWOT CRDT + anti-entropy the
// Node already proves under frame loss, so presences converge and are hidden on nodedown for free.
// Pair it with a PubSub for live join/leave diffs.
export {
  presence,
  type Presence,
  type Meta,
  type PresenceList,
  type PresenceDiff,
} from './presence.ts';

// shardedPresence: the partitioned counterpart — each topic's presence lives on one rendezvous-
// chosen coordinator (memory scales with the cluster), re-homing on membership change. The first
// concrete consumer of the sharded-registry idea (#1), scoped to presence.
export { shardedPresence, type ShardedPresence } from './sharded.ts';
