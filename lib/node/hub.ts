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

  wss.on('connection', (socket: WsSocket) => {
    const names = new Set<string>();
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      try {
        const frame = codec.decode(isBinary ? new Uint8Array(data) : data.toString());
        if (frame.kind === 'hello') names.add(frame.from);
        else if (frame.kind === 'bye') names.delete(frame.from);
      } catch {
        return; // not our wire — drop it rather than relay garbage
      }
      for (const peer of wss.clients) {
        if (peer !== socket && peer.readyState === 1) peer.send(data, { binary: isBinary });
      }
    });
    // Erlang's nodedown: a dropped socket gets its byes said for it.
    socket.on('close', () => {
      for (const name of names) {
        const bye = codec.encode({ kind: 'bye', from: name });
        for (const peer of wss.clients) {
          if (peer.readyState === 1) peer.send(bye, { binary: typeof bye !== 'string' });
        }
      }
    });
  });

  return {
    port: () => (wss.address() as { port: number }).port,
    close: () => new Promise<void>((done) => wss.close(() => done())),
  };
}
