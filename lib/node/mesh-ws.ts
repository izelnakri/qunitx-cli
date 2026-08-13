/**
 * The mesh over **real sockets** — the production binding for {@link meshTransport} (Node-only:
 * it stands on the repo's `ws` dependency for the LISTENING side, so it is deliberately NOT
 * exported from the barrel; the dialing side, {@link webSocketMeshLink}, is universal). Each node
 * listens on a port and dials one outbound WebSocket per peer; a directed frame rides the dialed
 * socket straight to its target — no relay hub, no SPOF. A pair of nodes uses one socket per
 * direction (dial-back for replies), which keeps the protocol trivially correct: frames carry
 * `from`, so the listener never needs to know which socket belongs to whom.
 *
 * ```ts
 * // Defined, not invoked: binds a real port.
 * function boot(self: string, port: number, roster: () => Record<string, string>) {
 *   const mesh = wsMeshTransport(self, { port, peers: roster }); // name -> ws://host:port
 *   return mesh; // Node.start(self, mesh.transport), later mesh.close()
 * }
 * ```
 */
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { Server } from 'node:http';
import { meshTransport, webSocketMeshLink } from './mesh.ts';
import { binaryCodec, type Codec } from './ws.ts';
import type { Transport, Frame } from './node.ts';

/**
 * A mesh transport over real WebSockets: listen on `port` for inbound peers, dial each peer in
 * `peers()` (a live `name → ws://url` roster — from {@link cluster} discovery or config). Returns
 * the composed {@link Transport} for `Node.start`, the bound port, and a full teardown. A peer
 * added to the roster later is dialed on the next poll and the node re-announces itself; a dead
 * socket is re-dialed automatically.
 *
 * ```ts
 * // Defined, not invoked: binds a real port.
 * function ephemeral(self: string) {
 *   return wsMeshTransport(self, { port: 0, peers: () => ({}) }); // read .port() after listen
 * }
 * ```
 */
export function wsMeshTransport(
  self: string,
  options: {
    port?: number;
    /**
     * Attach to an existing `http`/`https.Server` instead of binding `port` — this is how the
     * mesh runs over **TLS (`wss://`)**: pass an `https.createServer({ cert, key })` here and
     * give peers `wss://…` URLs (the {@link webSocketMeshLink} dialer already does TLS from a
     * `wss` URL — the native `WebSocket` handles it). Lib doesn't manage certs; you bring the
     * server, and you own its lifecycle (`close()` here shuts the socket layer, not your server).
     */
    server?: Server;
    peers: () => Record<string, string>;
    codec?: Codec;
    pollMs?: number;
  },
): { transport: Transport; port: () => number; close: () => Promise<void> } {
  const codec = options.codec ?? binaryCodec;
  const wss = new WebSocketServer(
    options.server ? { server: options.server } : { port: options.port ?? 0 },
  );
  let inbound: (frame: Frame) => void = () => {};

  // The listening half: every inbound socket's frames fan into the node. Frames carry `from`,
  // so no per-socket identity is needed; replies go out on our own dialed link to that peer.
  wss.on('connection', (socket: WsSocket) => {
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      try {
        inbound(codec.decode(isBinary ? new Uint8Array(data) : data.toString()));
      } catch {
        // not our wire — drop it
      }
    });
  });

  // The dialing half: the universal mesh core routes by peer over per-peer WebSocket links.
  const inner = meshTransport(self, {
    peers: () => Object.keys(options.peers()),
    link: (peer) => webSocketMeshLink(options.peers()[peer], codec),
    pollMs: options.pollMs,
  });

  const transport: Transport = {
    send: (frame) => inner.send(frame),
    onFrame(handler) {
      inbound = handler;
      inner.onFrame(handler);
    },
    onReopen: (cb) => inner.onReopen?.(cb),
    close: () => inner.close?.(),
  };

  const address = (): { port: number } => (options.server ?? wss).address() as { port: number };
  return {
    transport,
    port: () => address().port,
    close: () =>
      new Promise<void>((done) => {
        inner.close?.();
        for (const client of wss.clients) client.terminate();
        wss.close(() => done()); // closes the WS layer; an injected server stays the caller's to close
      }),
  };
}
