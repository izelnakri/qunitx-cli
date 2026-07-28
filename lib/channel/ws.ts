/**
 * The channel WebSocket **server** — the last mile that accepts real browser sockets and hands
 * each one to {@link serveSocket} (Node-only: it stands on the repo's `ws` dependency, so it is
 * deliberately NOT exported from the channel barrel; clients stay universal and dial in with
 * {@link webSocketWire}).
 *
 * One listener per gateway node: each inbound socket becomes a {@link Wire} (same codec seam as
 * the client — JSON by default, binary optional) and is served with the channel server's
 * `join`/`handleIn` behavior plus the slow-client/inbound-throttle options.
 *
 * ```ts
 * // Defined, not invoked: binds a real port.
 * import type { ChannelServer } from './channel.ts';
 * function boot(server: ChannelServer) {
 *   const edge = serveChannelsOverWs(server, { port: 0 }); // OS-assigned; read edge.port()
 *   return edge.close;
 * }
 * ```
 */
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { serveSocket, jsonWireCodec, type Wire, type WireCodec } from './client.ts';
import type { ChannelServer } from './channel.ts';

/**
 * Accept WebSocket connections on `port` and serve each with `server`. `codec` must match what
 * clients pass to {@link webSocketWire}; `maxPending`/`inbound` are per-socket
 * {@link serveSocket} guards. Returns the bound port and a close that severs every client.
 *
 * ```ts
 * // Defined, not invoked: binds a real port.
 * import type { ChannelServer } from './channel.ts';
 * function ephemeral(server: ChannelServer) {
 *   return serveChannelsOverWs(server, { port: 0 });
 * }
 * ```
 */
export function serveChannelsOverWs(
  server: ChannelServer,
  options: {
    port: number;
    codec?: WireCodec;
    maxPending?: number;
    inbound?: () => { tryAcquire(n?: number): boolean };
  },
): { port: () => number; close: () => Promise<void> } {
  const codec = options.codec ?? jsonWireCodec;
  const wss = new WebSocketServer({ port: options.port });

  wss.on('connection', (socket: WsSocket) => {
    const wire: Wire = {
      send: (msg) => {
        const data = codec.encode(msg);
        socket.send(data, { binary: typeof data !== 'string' });
      },
      onMessage: (handler) =>
        socket.on('message', (data: Buffer, isBinary: boolean) => {
          try {
            handler(codec.decode(isBinary ? new Uint8Array(data) : data.toString()));
          } catch {
            // not our wire — drop the frame rather than crash the socket
          }
        }),
      onClose: (handler) => socket.on('close', () => handler()),
      pending: () => socket.bufferedAmount,
      close: () => socket.close(),
    };
    serveSocket(server, wire, {
      maxPending: options.maxPending,
      // A fresh limiter per socket: each client gets its own inbound budget.
      inbound: options.inbound?.(),
    });
  });

  return {
    port: () => (wss.address() as { port: number }).port,
    close: () =>
      new Promise<void>((done) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => done());
      }),
  };
}
