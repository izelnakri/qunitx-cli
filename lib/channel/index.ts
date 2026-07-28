// Barrel for the Channel leg: import * as Channel from '.../lib/channel/index.ts'.
//
// Elixir's Phoenix Channels — the client-facing real-time layer. A client connects over a Socket,
// joins topics, sends events, and receives pushes; the server authorizes joins, handles inbound
// events, and broadcasts to every subscribed client across the cluster via PubSub. Transport-
// agnostic (a WebSocket in prod, an in-memory Socket in tests); pair with Presence for who's-here.
export {
  channelServer,
  type ChannelServer,
  type Connection,
  type ChannelDef,
  type Socket,
  type JoinResult,
} from './channel.ts';
