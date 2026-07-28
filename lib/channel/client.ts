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

/** An abstract bidirectional message pipe — a WebSocket, a MessagePort, or an in-memory link. */
export interface Wire {
  /** Send one message to the other end. */
  send(msg: unknown): void;
  /** Register the inbound-message handler. */
  onMessage(handler: (msg: unknown) => void): void;
  /** Register a handler for the pipe closing (a real socket's `close` event), if the pipe reports it. */
  onClose?(handler: () => void): void;
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
export function serveSocket(server: ChannelServer, wire: Wire): () => void {
  const id = `sock:${++socketSeq}`;
  const conn = server.connect({
    id,
    push: (topic, event, payload) => wire.send({ t: 'push', topic, event, payload }),
  });
  wire.onMessage((raw) => {
    const m = raw as Inbound;
    if (m.t === 'join')
      wire.send({ t: 'reply', ref: m.ref, result: conn.join(m.topic, m.payload) });
    else if (m.t === 'event')
      wire.send({ t: 'reply', ref: m.ref, result: conn.push(m.topic, m.event, m.payload) ?? null });
    else if (m.t === 'leave') conn.leave(m.topic);
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

/**
 * Adapt a native `WebSocket` (a web standard — no dependency) into a {@link Wire}: JSON on the
 * wire, sends buffered until the socket opens. Pass `() => webSocketWire(url)` as
 * {@link channelClient}'s `connect` to talk to a server over a real socket.
 *
 * ```ts
 * typeof webSocketWire; // 'function'
 * ```
 */
export function webSocketWire(url: string): Wire {
  const socket = new WebSocket(url);
  const backlog: string[] = [];
  socket.addEventListener('open', () => {
    for (const msg of backlog.splice(0)) socket.send(msg);
  });
  return {
    send(msg) {
      const data = JSON.stringify(msg);
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
      else backlog.push(data);
    },
    onMessage(handler) {
      socket.addEventListener('message', (event) =>
        handler(JSON.parse((event as MessageEvent).data)),
      );
    },
    onClose(handler) {
      socket.addEventListener('close', () => handler());
    },
    close: () => socket.close(),
  };
}
