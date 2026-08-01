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
import { createServer, type Server } from 'node:https';
import { binaryCodec, type Codec } from './ws.ts';
import { authDigest, randomNonce, safeEqual } from './auth.ts';

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
export function startHub(
  options: {
    port?: number;
    codec?: Codec;
    /**
     * Shared cluster secret (Erlang's magic cookie). When set, the hub challenges every socket on
     * connect and relays NOTHING until it proves HMAC(secret, nonce) — an unauthenticated socket is
     * dropped, closing the "any socket joins the cluster" hole. Nodes prove it via `wsTransport`'s
     * matching `secret`. When unset, the hub is open (today's behavior — no forced migration).
     */
    secret?: string;
    /** TLS materials — run the hub over `wss://` (encrypt the wire). PEM cert + private key. */
    tls?: { cert: string | Buffer; key: string | Buffer };
  } = {},
): {
  port: () => number;
  close: () => Promise<void>;
} {
  const codec = options.codec ?? binaryCodec;
  const secret = options.secret;
  // TLS: bind an https server and mount the WS server on it; otherwise ws binds the port directly.
  const tlsServer: Server | undefined = options.tls
    ? createServer({ cert: options.tls.cert, key: options.tls.key })
    : undefined;
  const wss = tlsServer
    ? new WebSocketServer({ server: tlsServer })
    : new WebSocketServer({ port: options.port ?? 4369 });
  if (tlsServer) tlsServer.listen(options.port ?? 4369);
  // node name -> the socket hosting it, so a frame WITH a `to` routes point-to-point instead
  // of broadcasting to the whole cluster (the O(N^2) call-traffic wall). Frames without a `to`
  // (hello/bye/join/register gossip) still broadcast; an unknown `to` falls back to broadcast.
  const ownerSocket = new Map<string, WsSocket>();

  wss.on('connection', (socket: WsSocket) => {
    const names = new Set<string>();
    // Cluster-join auth (Erlang's cookie): challenge the socket, relay nothing until it proves the
    // secret. `pending` buffers what it sends meanwhile; a bad proof or a 5s no-show drops the socket.
    const nonce = secret ? randomNonce() : '';
    let authed = !secret;
    const pending: Array<[Buffer, boolean]> = [];
    if (secret) {
      socket.send(codec.encode({ kind: 'challenge', from: '', nonce }));
      const timer = setTimeout(() => authed || socket.terminate(), 5000);
      (timer as { unref?: () => void }).unref?.();
    }

    const relay = (data: Buffer, isBinary: boolean): void => {
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
    };

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (secret && !authed) {
        // The only frame we read before auth is the proof; everything else waits (or is a no-op).
        let frame;
        try {
          frame = codec.decode(isBinary ? new Uint8Array(data) : data.toString());
        } catch {
          return;
        }
        if (frame.kind === 'auth') {
          void authDigest(secret, nonce).then((expected) => {
            if (frame.digest && safeEqual(frame.digest, expected)) {
              authed = true;
              for (const [buffered, bin] of pending.splice(0)) relay(buffered, bin);
            } else socket.terminate(); // wrong cookie — no cluster for you
          });
        } else if (pending.length < 256) pending.push([data, isBinary]); // buffer, bounded
        return;
      }
      relay(data, isBinary);
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
    port: () =>
      ((tlsServer ?? wss).address() as { port: number }).port ??
      (wss.address() as { port: number }).port,
    close: () =>
      new Promise<void>((done) => {
        // ws's close() waits for clients that may never leave — sever them first, then close.
        for (const client of wss.clients) client.terminate();
        wss.close(() => (tlsServer ? tlsServer.close(() => done()) : done()));
      }),
  };
}
