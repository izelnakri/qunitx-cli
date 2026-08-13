/**
 * The **WebSocket edge** for {@link channelServer} — the last mile to a real browser. A
 * {@link ChannelServer} pushes to a {@link Socket}; this bridges that Socket to a live duplex on
 * both ends: `serveSocket` wires one client connection into the server, and `channelClient` is the
 * browser-side handle that `join`s topics and receives pushes — with the two things a real socket
 * needs that the in-memory `Socket` doesn't: a **heartbeat** (detect a dead connection the OS hasn't
 * reported) and **auto-rejoin** (transparently reconnect and re-`join` every topic after a drop, so
 * an app doesn't re-subscribe by hand). This is Phoenix's `phx_heartbeat` + channel rejoin.
 *
 * The protocol rides an abstract {@link Wire} (a duplex of JSON-ish messages), so it's universal
 * and testable in-memory; {@link webSocketWire} adapts a native `WebSocket` (a web standard, so no
 * dependency) for production.
 *
 * ```ts
 * // A no-op wire; the tests drive a full client↔server round-trip over linked in-memory wires.
 * const client = channelClient({
 *   connect: (): Wire => ({ send: () => {}, onMessage: () => {}, close: () => {} }),
 *   heartbeatMs: false,
 * });
 * typeof client.join; // 'function'
 * client.close();
 * ```
 */
import type { ChannelServer, JoinResult } from './channel.ts';
import { execute as emit } from '../telemetry/telemetry.ts';
import { binaryCodec } from '../node/ws.ts';
import type { Frame } from '../node/node.ts';

/** An abstract bidirectional message pipe — a WebSocket, a MessagePort, or an in-memory link. */
export interface Wire {
  /** Send one message to the other end. */
  send(msg: unknown): void;
  /** Register the inbound-message handler. */
  onMessage(handler: (msg: unknown) => void): void;
  /** Register a handler for the pipe closing (a real socket's `close` event), if the pipe reports it. */
  onClose?(handler: () => void): void;
  /** Bytes/messages queued but not yet flushed to the peer (a WebSocket's `bufferedAmount`), if known. */
  pending?(): number;
  /** Close the pipe. */
  close(): void;
}

type Inbound =
  | { t: 'join'; ref: number; topic: string; payload?: unknown }
  | { t: 'event'; ref: number; topic: string; event: string; payload?: unknown }
  | { t: 'leave'; topic: string }
  | { t: 'hb' };

let socketSeq = 0;

/**
 * Server side: bridge one client's {@link Wire} into `server`. Inbound `join`/`event`/`leave` drive
 * a {@link ChannelServer} connection and get a `reply`; server pushes become `push` messages; a
 * heartbeat is echoed. Returns a teardown that disconnects the client.
 *
 * ```ts
 * import { start, memoryHub } from '../node/index.ts';
 * import { pubsub } from '../pubsub/index.ts';
 * import { channelServer } from './channel.ts';
 * const node = start('gw@wc2', memoryHub().transport());
 * const server = channelServer(node, pubsub(node), {});
 * const wire: Wire = { send: () => {}, onMessage: () => {}, close: () => {} };
 * const off = serveSocket(server, wire);
 * off();
 * node.stop();
 * ```
 */
export function serveSocket(
  server: ChannelServer,
  wire: Wire,
  options: {
    /** Disconnect a client whose outbound backlog (`wire.pending()`) exceeds this — the Phoenix
     *  slow-client policy: a consumer that can't keep up is dropped, not allowed to grow an
     *  unbounded queue. Emits `['channel','slow-client']` telemetry and calls `onSlowClient`. */
    maxPending?: number;
    /** Fired when a slow client is dropped. */
    onSlowClient?: () => void;
    /** Inbound throttle — anything with `tryAcquire()` (a `rateLimiter` from the node barrel).
     *  An `event` beyond the limit is answered `{ error: 'throttled' }` and never reaches
     *  `handleIn`. */
    inbound?: { tryAcquire(n?: number): boolean };
  } = {},
): () => void {
  const id = `sock:${++socketSeq}`;
  let dropped = false;
  const drop = (): void => {
    if (dropped) return;
    dropped = true;
    conn.disconnect();
    wire.close();
    emit(['channel', 'slow-client'], { pending: wire.pending?.() ?? 0 }, { socket: id });
    options.onSlowClient?.();
  };
  const conn = server.connect({
    id,
    push: (topic, event, payload) => {
      // The slow-client guard: a backlog past maxPending means the client isn't draining.
      if (options.maxPending !== undefined && (wire.pending?.() ?? 0) > options.maxPending)
        return drop();
      wire.send({ t: 'push', topic, event, payload });
    },
  });
  wire.onMessage((raw) => {
    const m = raw as Inbound;
    if (m.t === 'join')
      wire.send({ t: 'reply', ref: m.ref, result: conn.join(m.topic, m.payload) });
    else if (m.t === 'event') {
      if (options.inbound && !options.inbound.tryAcquire())
        return wire.send({ t: 'reply', ref: m.ref, result: { error: 'throttled' } });
      // An async handleIn is awaited — the client's reply arrives after the durable write.
      void conn
        .push(m.topic, m.event, m.payload)
        .then((result) => wire.send({ t: 'reply', ref: m.ref, result: result ?? null }))
        .catch(() => wire.send({ t: 'reply', ref: m.ref, result: { error: 'internal error' } }));
    } else if (m.t === 'leave') conn.leave(m.topic);
    else if (m.t === 'hb') wire.send({ t: 'hb' });
  });
  wire.onClose?.(() => conn.disconnect()); // client dropped → free its subscriptions
  return () => conn.disconnect();
}

/** A browser-side channel handle — see {@link channelClient}. */
export interface ChannelClient {
  /** Join a topic; resolves with the server's authorize result. Re-issued automatically on reconnect. */
  join(topic: string, payload?: unknown): Promise<JoinResult>;
  /** Send an event on a topic; resolves with the server's reply (or null). */
  push(topic: string, event: string, payload?: unknown): Promise<unknown>;
  /** Register a handler for pushes of `event` on `topic`; returns an off. */
  on(topic: string, event: string, handler: (payload: unknown) => void): () => void;
  /** Leave a topic. */
  leave(topic: string): void;
  /** Close the client (stops the heartbeat and the wire). */
  close(): void;
}

/**
 * Browser side: a channel client over a (re)dialable {@link Wire}. `connect` opens a wire (call it
 * again to redial); a heartbeat every `heartbeatMs` detects a dead connection (no echo within two
 * beats) and triggers a reconnect that **re-joins every joined topic** transparently. `onReconnect`
 * fires after a successful rejoin.
 *
 * ```ts
 * const wires: Wire[] = [];
 * const client = channelClient({
 *   connect: () => {
 *     const w: Wire = { send: () => {}, onMessage: () => {}, close: () => {} };
 *     wires.push(w);
 *     return w;
 *   },
 *   heartbeatMs: false,
 * });
 * wires.length; // 1 — connected on construction
 * client.close();
 * ```
 */
export function channelClient(options: {
  connect: () => Wire;
  heartbeatMs?: number | false;
  onReconnect?: () => void;
}): ChannelClient {
  const joined = new Map<string, unknown>(); // topic -> last join payload (for rejoin)
  const handlers = new Map<string, Set<(payload: unknown) => void>>(); // `topicevent` -> fns
  const pending = new Map<number, (result: unknown) => void>();
  let ref = 0;
  let wire!: Wire;
  let alive = true;
  let hbAcked = true;

  const dispatch = (raw: unknown): void => {
    const m = raw as {
      t: string;
      ref?: number;
      result?: unknown;
      topic?: string;
      event?: string;
      payload?: unknown;
    };
    if (m.t === 'reply') pending.get(m.ref!)?.(m.result);
    else if (m.t === 'push') {
      for (const fn of handlers.get(`${m.topic}${m.event}`) ?? []) fn(m.payload);
    } else if (m.t === 'hb') hbAcked = true;
  };

  const open = (): void => {
    wire = options.connect();
    wire.onMessage(dispatch);
    wire.onClose?.(() => reconnect()); // reconnect promptly on a reported close (heartbeat covers silent deaths)
  };

  const reconnect = (): void => {
    if (!alive) return;
    wire.close();
    open();
    for (const [topic, payload] of joined) wire.send({ t: 'join', ref: ++ref, topic, payload }); // rejoin
    options.onReconnect?.();
  };

  open();

  let hbTimer: ReturnType<typeof setInterval> | undefined;
  if (options.heartbeatMs !== false) {
    hbTimer = setInterval(() => {
      if (!hbAcked) return reconnect(); // missed the previous beat's echo — the wire is dead
      hbAcked = false;
      wire.send({ t: 'hb' });
    }, options.heartbeatMs ?? 5000);
    (hbTimer as { unref?: () => void }).unref?.();
  }

  const request = (msg: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve) => {
      const id = ++ref;
      pending.set(id, (result) => {
        pending.delete(id);
        resolve(result);
      });
      wire.send({ ...msg, ref: id });
    });

  return {
    async join(topic, payload) {
      joined.set(topic, payload);
      return (await request({ t: 'join', topic, payload })) as JoinResult;
    },
    push: (topic, event, payload) => request({ t: 'event', topic, event, payload }),
    on(topic, event, handler) {
      const key = `${topic}${event}`;
      (handlers.get(key) ?? handlers.set(key, new Set()).get(key)!).add(handler);
      return () => handlers.get(key)?.delete(handler);
    },
    leave(topic) {
      joined.delete(topic);
      wire.send({ t: 'leave', topic });
    },
    close() {
      alive = false;
      if (hbTimer) clearInterval(hbTimer);
      wire.close();
    },
  };
}

/** How channel messages are serialized on a wire — the codec seam of {@link webSocketWire}. */
export interface WireCodec {
  /** Encode one message for the socket. */
  encode(msg: unknown): string | Uint8Array;
  /** Decode what arrived. */
  decode(data: string | Uint8Array): unknown;
}

/**
 * The reference codec: JSON text — readable in devtools, the default.
 *
 * ```ts
 * jsonWireCodec.decode(jsonWireCodec.encode({ t: 'hb' }) as string); // { t: 'hb' }
 * ```
 */
export const jsonWireCodec: WireCodec = {
  encode: (msg) => JSON.stringify(msg),
  decode: (data) => JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)),
};

/**
 * The binary codec: the node leg's tagged, length-prefixed encoding (ETF-in-spirit — bytes cross
 * as bytes, no base64 detour, smaller frames than JSON). Pass to {@link webSocketWire} on both
 * ends for a binary channel wire.
 *
 * ```ts
 * const wire = binaryWireCodec.encode({ t: 'push', topic: 'room:1' });
 * (binaryWireCodec.decode(wire as Uint8Array) as { topic: string }).topic; // 'room:1'
 * ```
 */
export const binaryWireCodec: WireCodec = {
  // The node codec's encoder is structurally generic (tagged terms); Frame is its nominal type.
  encode: (msg) => binaryCodec.encode(msg as Frame),
  decode: (data) => binaryCodec.decode(data),
};

/**
 * Adapt a native `WebSocket` (a web standard — no dependency) into a {@link Wire}: `codec` on the
 * wire (JSON by default, {@link binaryWireCodec} for binary), sends buffered until the socket
 * opens, and `pending()` = `bufferedAmount` (what the slow-client guard reads). Pass
 * `() => webSocketWire(url)` as {@link channelClient}'s `connect` to talk to a server over a
 * real socket.
 *
 * ```ts
 * typeof webSocketWire; // 'function'
 * ```
 */
export function webSocketWire(url: string, codec: WireCodec = jsonWireCodec): Wire {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const backlog: (string | Uint8Array)[] = [];
  socket.addEventListener('open', () => {
    for (const msg of backlog.splice(0)) socket.send(msg);
  });
  return {
    send(msg) {
      const data = codec.encode(msg);
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
      else backlog.push(data);
    },
    onMessage(handler) {
      socket.addEventListener('message', (event) => {
        const data = (event as MessageEvent).data;
        handler(
          codec.decode(typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer)),
        );
      });
    },
    onClose(handler) {
      socket.addEventListener('close', () => handler());
    },
    pending: () => socket.bufferedAmount,
    close: () => socket.close(),
  };
}
