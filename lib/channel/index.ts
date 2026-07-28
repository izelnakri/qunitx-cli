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

// The WebSocket edge: serveSocket bridges a client wire into the server (with slow-client +
// inbound-throttle guards); channelClient is the browser-side handle with heartbeat + auto-rejoin;
// webSocketWire adapts a native WebSocket with a codec seam (JSON reference, binary optional).
// The ws SERVER binding lives in ./ws.ts, deliberately OUTSIDE this barrel: it stands on the `ws`
// package, and the barrel stays browser-safe.
export {
  serveSocket,
  channelClient,
  webSocketWire,
  jsonWireCodec,
  binaryWireCodec,
  type Wire,
  type WireCodec,
  type ChannelClient,
} from './client.ts';

// The long-poll fallback (Phoenix.Transports.LongPoll): the same channel protocol over plain
// POSTs — a pure request→response endpoint server-side, a Wire client-side, so channelClient
// works unchanged where a WebSocket can't be had.
export {
  longPollEndpoint,
  longPollWire,
  type LongPollRequest,
  type LongPollResponse,
} from './longpoll.ts';
