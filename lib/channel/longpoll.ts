/**
 * The **long-poll fallback** — Phoenix's `Phoenix.Transports.LongPoll`: the same channel protocol
 * when a WebSocket can't be had (restrictive proxies, corporate networks, exotic embedders). The
 * server side is a pure request→response function, so it binds to ANY http server in one line;
 * the client side is a {@link Wire}, so {@link channelClient} works unchanged — heartbeat,
 * auto-rejoin and all — over plain POSTs.
 *
 * Protocol: each response carries the `session` id and any queued `messages`. A request with
 * `send` delivers client→server messages and returns immediately; a bare poll **holds** up to
 * `holdMs` waiting for a push (that hold is the "long" in long-poll). Sessions expire after
 * `ttlMs` without contact (the client's poll loop keeps a live session fresh forever).
 *
 * ```ts
 * import { start, memoryHub } from '../node/index.ts';
 * import { pubsub } from '../pubsub/index.ts';
 * import { channelServer } from './channel.ts';
 * import { channelClient } from './client.ts';
 * const node = start('gw@lp', memoryHub().transport());
 * const endpoint = longPollEndpoint(channelServer(node, pubsub(node), {}));
 * // In-memory "HTTP": the client's post IS the endpoint handler. Real apps wire it to a route.
 * const client = channelClient({
 *   connect: () => longPollWire((body) => endpoint.handle(body)),
 *   heartbeatMs: false,
 * });
 * 'ok' in (await client.join('room:1')); // true — the same channel protocol, no WebSocket
 * client.close();
 * node.stop();
 * ```
 */
import { serveSocket, type Wire } from './client.ts';
import type { ChannelServer } from './channel.ts';

/** One long-poll exchange: what a client POSTs to the endpoint. */
export interface LongPollRequest {
  /** The session to continue — absent on first contact (the response assigns one). */
  session?: string;
  /** Client→server messages to deliver (a send request — returns immediately). */
  send?: unknown[];
  /** End the session (the client closed). */
  bye?: boolean;
}

/** One long-poll exchange: what the endpoint responds. */
export interface LongPollResponse {
  /** The session id — echo it on every subsequent request. */
  session: string;
  /** Server→client messages queued since the last exchange. */
  messages: unknown[];
}

interface Session {
  outbox: unknown[];
  waiter?: (messages: unknown[]) => void;
  inbound: (msg: unknown) => void;
  teardown: () => void;
  lastSeen: number;
}

/**
 * The server side: a pure `handle(request)` you bind to any http route — no framework coupling.
 *
 * ```ts
 * import { start, memoryHub } from '../node/index.ts';
 * import { pubsub } from '../pubsub/index.ts';
 * import { channelServer } from './channel.ts';
 * const node = start('gw@lp2', memoryHub().transport());
 * const endpoint = longPollEndpoint(channelServer(node, pubsub(node), {}));
 * const first = await endpoint.handle({}); // first contact opens a session
 * typeof first.session; // 'string'
 * node.stop();
 * ```
 */
export function longPollEndpoint(
  server: ChannelServer,
  options: { holdMs?: number; ttlMs?: number } = {},
): { handle(request: LongPollRequest): Promise<LongPollResponse> } {
  const holdMs = options.holdMs ?? 25000;
  const ttlMs = options.ttlMs ?? 60000;
  const sessions = new Map<string, Session>();

  const sweep = (): void => {
    const now = Date.now();
    for (const [sid, session] of [...sessions]) {
      if (now - session.lastSeen > ttlMs) {
        session.teardown();
        session.waiter?.([]);
        sessions.delete(sid);
      }
    }
  };

  const open = (): [string, Session] => {
    const sid = crypto.randomUUID();
    const session: Session = {
      outbox: [],
      inbound: () => {},
      teardown: () => {},
      lastSeen: Date.now(),
    };
    // The queue-backed Wire: server pushes land in the outbox (or wake the held poll); inbound
    // messages are fed by handle() below.
    const wire: Wire = {
      send(msg) {
        if (session.waiter) {
          const wake = session.waiter;
          session.waiter = undefined;
          wake([msg]);
        } else session.outbox.push(msg);
      },
      onMessage: (handler) => void (session.inbound = handler),
      close: () => void 0,
    };
    session.teardown = serveSocket(server, wire);
    sessions.set(sid, session);
    return [sid, session];
  };

  return {
    handle(request) {
      sweep();
      let sid = request.session;
      let session = sid !== undefined ? sessions.get(sid) : undefined;
      const fresh = !session;
      if (!session) [sid, session] = open(); // first contact or an expired session — reopen
      session.lastSeen = Date.now();

      if (request.bye) {
        session.teardown();
        session.waiter?.([]); // release a held poll so the client's loop can exit
        sessions.delete(sid!);
        return Promise.resolve({ session: sid!, messages: [] });
      }
      for (const msg of request.send ?? []) session.inbound(msg);

      // First contact and send requests return at once (the client needs its session id / reply
      // fast); only an established bare poll HOLDS for a push.
      if (fresh || session.outbox.length > 0 || (request.send?.length ?? 0) > 0) {
        return Promise.resolve({ session: sid!, messages: session.outbox.splice(0) });
      }
      return new Promise<LongPollResponse>((resolve) => {
        session.waiter?.([]); // a superseded poll returns empty — one held poll per session
        const timer = setTimeout(() => {
          if (session.waiter === wake) session.waiter = undefined;
          resolve({ session: sid!, messages: session.outbox.splice(0) });
        }, holdMs);
        const wake = (messages: unknown[]): void => {
          clearTimeout(timer);
          resolve({ session: sid!, messages });
        };
        session.waiter = wake;
      });
    },
  };
}

/**
 * The client side: a {@link Wire} over a `post` function (a `fetch` in the browser, the endpoint
 * itself in tests). One background poll loop pulls pushes; sends fire their own request. Hand it
 * to {@link channelClient} and everything else — heartbeat, rejoin — works unchanged.
 *
 * ```ts
 * const wire = longPollWire(() => Promise.resolve({ session: 's', messages: [] }));
 * typeof wire.send; // 'function'
 * wire.close();
 * ```
 */
export function longPollWire(post: (body: LongPollRequest) => Promise<LongPollResponse>): Wire {
  let session: string | undefined;
  let handler: (msg: unknown) => void = () => {};
  let alive = true;
  const backlog: unknown[] = [];

  const deliver = (response: LongPollResponse): void => {
    session = response.session;
    for (const msg of response.messages) handler(msg);
  };

  const poll = async (): Promise<void> => {
    while (alive) {
      try {
        deliver(await post({ session }));
      } catch {
        break; // the transport is gone — the channelClient heartbeat will redial
      }
    }
  };

  // First contact establishes the session, flushes anything sent before it, then starts polling.
  void post({})
    .then((response) => {
      deliver(response);
      if (backlog.length > 0) return post({ session, send: backlog.splice(0) }).then(deliver);
    })
    .then(() => void poll())
    .catch(() => void 0);

  return {
    send(msg) {
      if (!alive) return;
      if (session === undefined) return void backlog.push(msg); // pre-session — flushed above
      void post({ session, send: [msg] })
        .then(deliver)
        .catch(() => void 0);
    },
    onMessage: (fn) => void (handler = fn),
    close() {
      alive = false;
      if (session !== undefined) void post({ session, bye: true }).catch(() => void 0);
    },
  };
}
