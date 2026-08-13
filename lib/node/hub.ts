/**
 * The relay hub — epmd and the mesh in one small server (Node-only: it stands on the repo's
 * `ws` dependency, so it is deliberately NOT exported from the barrel; nodes themselves stay
 * universal and dial in with {@link wsTransport}).
 *
 * Frames are relayed opaquely to every other socket; the hub decodes only enough to learn
 * which node names live on each socket — because its second job is Erlang's nodedown: when a
 * socket drops without a polite bye, the hub says bye for it, and every surviving node's
 * `monitor()` fires.
 *
 * ```ts
 * // Defined, not invoked: binds a real port.
 * function boot(port: number) {
 *   const hub = startHub({ port }); // node hub.ts — then any process dials ws://host:port
 *   return hub.close;
 * }
 * ```
 */
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { binaryCodec, type Codec } from './ws.ts';

/**
 * Starts the relay on `port` (default 4369 — epmd's, for the culture). Returns `close()`.
 *
 * ```ts
 * // Defined, not invoked: binds a real port.
 * function ephemeral() {
 *   return startHub({ port: 0 }); // OS-assigned; read it back from .port
 * }
 * ```
 */
export function startHub(options: { port?: number; codec?: Codec } = {}): {
  port: () => number;
  close: () => Promise<void>;
} {
  const codec = options.codec ?? binaryCodec;
  const wss = new WebSocketServer({ port: options.port ?? 4369 });
  // node name -> the socket hosting it, so a frame WITH a `to` routes point-to-point instead
  // of broadcasting to the whole cluster (the O(N^2) call-traffic wall). Frames without a `to`
  // (hello/bye/join/register gossip) still broadcast; an unknown `to` falls back to broadcast.
  const ownerSocket = new Map<string, WsSocket>();

  wss.on('connection', (socket: WsSocket) => {
    const names = new Set<string>();
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      let frame;
      try {
        frame = codec.decode(isBinary ? new Uint8Array(data) : data.toString());
      } catch {
        return; // not our wire — drop it rather than relay garbage
      }
      names.add(frame.from);
      ownerSocket.set(frame.from, socket); // learn where each node lives
      if (frame.kind === 'bye') (names.delete(frame.from), ownerSocket.delete(frame.from));

      const direct = frame.to !== undefined ? ownerSocket.get(frame.to) : undefined;
      const targets = direct ? [direct] : wss.clients;
      for (const peer of targets) {
        if (peer !== socket && peer.readyState === 1) peer.send(data, { binary: isBinary });
      }
    });
    // Erlang's nodedown: a dropped socket gets its byes said for it.
    socket.on('close', () => {
      for (const name of names) {
        ownerSocket.delete(name);
        const bye = codec.encode({ kind: 'bye', from: name });
        for (const peer of wss.clients) {
          if (peer.readyState === 1) peer.send(bye, { binary: typeof bye !== 'string' });
        }
      }
    });
  });

  return {
    port: () => (wss.address() as { port: number }).port,
    close: () =>
      new Promise<void>((done) => {
        // ws's close() waits for clients that may never leave — sever them first, then close.
        for (const client of wss.clients) client.terminate();
        wss.close(() => done());
      }),
  };
}
