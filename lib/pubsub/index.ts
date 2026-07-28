// Barrel for the PubSub leg: import * as PubSub from '.../lib/pubsub/index.ts'.
//
// Elixir's Phoenix.PubSub — cluster-wide topic pub/sub built on the CRDT-backed process groups
// (as Phoenix.PubSub is built on pg). subscribe a handler to a topic; a broadcast on any node
// reaches every subscriber on every node. The messaging backbone under Channels and Presence.
export { pubsub, type PubSub, type PubSubHandler } from './pubsub.ts';
