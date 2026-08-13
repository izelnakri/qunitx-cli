// Barrel for the PubSub leg: import * as PubSub from '.../lib/pubsub/index.ts'.
//
// Elixir's Phoenix.PubSub — cluster-wide topic pub/sub built on the CRDT-backed process groups
// (as Phoenix.PubSub is built on pg). subscribe a handler to a topic; a broadcast on any node
// reaches every subscriber on every node. The messaging backbone under Channels and Presence.
export { pubsub, type PubSub, type PubSubHandler } from './pubsub.ts';

// reliablePubSub: an at-least-once variant (per-sender sequence, gap-triggered replay, dedup, and
// a heartbeat for tail-loss) for topics that need delivery guarantees over the fire-and-forget bus.
export { reliablePubSub } from './reliable.ts';
