/**
 * The socket half of distribution: a `Transport` over the web-standard `WebSocket` (native
 * in Node 22+, Deno, and browsers — no import), plus the two wire codecs. The default is
 * {@link binaryCodec} — a tagged, length-prefixed binary encoding in the family of Erlang's
 * External Term Format (ETF opens with magic 131; ours opens with 158) and Crockford's Nota:
 * bytes are first-class, nothing is base64-mangled, and a reader knows every value's extent
 * without parsing it. {@link jsonCodec} is the reference/debug codec: same frames as JSON
 * text, `Uint8Array` payloads riding base64 — readable in devtools, interop-friendly.
 *
 * ```ts
 * import type { Frame } from './node.ts';
 *
 * const frame: Frame = { kind: 'cast', from: 'a@ws', to: 'b@ws', subject: 'blob', payload: new Uint8Array([1, 2, 3]) };
 * const decoded = binaryCodec.decode(binaryCodec.encode(frame) as Uint8Array);
 * (decoded.payload as Uint8Array)[2]; // 3 — bytes cross as bytes, no base64 detour
 * ```
 */
import type { Frame, Transport } from './node.ts';
import { authDigest } from './auth.ts';

/** Encodes frames for a socket and decodes what arrives — the wire seam of {@link wsTransport}. */
export interface Codec {
  /** Frame → wire bytes (binary codecs) or text (JSON codecs). */
  encode(frame: Frame): Uint8Array | string;
  /** Wire data → frame. */
  decode(data: Uint8Array | string): Frame;
}

// Value tags, ETF-style: one byte says what follows, lengths are explicit u32s. 158 is OUR
// magic (ETF owns 131) so a mixed-up wire fails loudly instead of half-parsing.
const MAGIC = 158;
const T = { null: 0, false: 1, true: 2, number: 3, string: 4, bytes: 5, array: 6, map: 7 } as const;
const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

function encodeTerm(value: unknown, out: number[]): void {
  const pushU32 = (n: number) =>
    out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  if (value === null || value === undefined) out.push(T.null);
  else if (value === false) out.push(T.false);
  else if (value === true) out.push(T.true);
  else if (typeof value === 'number') {
    out.push(T.number);
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    for (let i = 0; i < 8; i++) out.push(view.getUint8(i));
  } else if (typeof value === 'string') {
    const bytes = utf8.encode(value);
    out.push(T.string);
    pushU32(bytes.length);
    for (const byte of bytes) out.push(byte);
  } else if (value instanceof Uint8Array) {
    out.push(T.bytes);
    pushU32(value.length);
    for (const byte of value) out.push(byte);
  } else if (Array.isArray(value)) {
    out.push(T.array);
    pushU32(value.length);
    for (const item of value) encodeTerm(item, out);
  } else if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    out.push(T.map);
    pushU32(entries.length);
    for (const [key, item] of entries) {
      encodeTerm(key, out);
      encodeTerm(item, out);
    }
  } else throw new TypeError(`unencodable value on the wire: ${typeof value}`);
}

function decodeTerm(view: DataView, cursor: { at: number }): unknown {
  const tag = view.getUint8(cursor.at++);
  const readU32 = () => {
    const n = view.getUint32(cursor.at);
    cursor.at += 4;
    return n;
  };
  if (tag === T.null) return null;
  else if (tag === T.false) return false;
  else if (tag === T.true) return true;
  else if (tag === T.number) {
    const n = view.getFloat64(cursor.at);
    cursor.at += 8;
    return n;
  } else if (tag === T.string || tag === T.bytes) {
    const length = readU32();
    const bytes = new Uint8Array(view.buffer, view.byteOffset + cursor.at, length).slice();
    cursor.at += length;
    return tag === T.string ? utf8d.decode(bytes) : bytes;
  } else if (tag === T.array) {
    const length = readU32();
    return Array.from({ length }, () => decodeTerm(view, cursor));
  } else if (tag === T.map) {
    const length = readU32();
    const object: Record<string, unknown> = {};
    for (let i = 0; i < length; i++) {
      const key = decodeTerm(view, cursor) as string;
      object[key] = decodeTerm(view, cursor);
    }
    return object;
  }
  throw new TypeError(`unknown wire tag ${tag} at ${cursor.at - 1}`);
}

/**
 * The default wire: tagged, length-prefixed binary — ETF's mechanism under our tags.
 * `Uint8Array` payloads cross as raw bytes; the `$failure` envelope is a map like any other,
 * so declared failures keep their identity in binary exactly as they do in JSON.
 *
 * ```ts
 * const wire = binaryCodec.encode({ kind: 'hello', from: 'a@ws' }) as Uint8Array;
 * wire[0]; // 158 — the magic byte (ETF uses 131; a mixed-up wire fails loudly)
 * binaryCodec.decode(wire).from; // 'a@ws'
 * ```
 */
export const binaryCodec: Codec = {
  encode(frame) {
    const out: number[] = [MAGIC];
    encodeTerm(frame as unknown as Record<string, unknown>, out);
    return Uint8Array.from(out);
  },
  decode(data) {
    const bytes = typeof data === 'string' ? utf8.encode(data) : data;
    if (bytes[0] !== MAGIC) throw new TypeError(`not a wire frame: magic ${bytes[0]} != ${MAGIC}`);
    return decodeTerm(new DataView(bytes.buffer, bytes.byteOffset + 1), { at: 0 }) as Frame;
  },
};

/**
 * The reference codec: frames as JSON text, `Uint8Array` values riding base64 under `$b64`
 * — for devtools-readable wires and non-JS peers. (Erlang itself never base64s its
 * distribution — ETF is binary — which is why this one is NOT the default.)
 *
 * ```ts
 * const text = jsonCodec.encode({ kind: 'cast', from: 'a@ws', subject: 'b', payload: new Uint8Array([255]) }) as string;
 * text.includes('$b64'); // true
 * (jsonCodec.decode(text).payload as Uint8Array)[0]; // 255
 * ```
 */
export const jsonCodec: Codec = {
  encode(frame) {
    return JSON.stringify(frame, (_key, value: unknown) =>
      value instanceof Uint8Array ? { $b64: btoa(String.fromCharCode(...value)) } : value,
    );
  },
  decode(data) {
    const text = typeof data === 'string' ? data : utf8d.decode(data);
    return JSON.parse(text, (_key, value: unknown) =>
      value !== null && typeof value === 'object' && '$b64' in (value as object)
        ? Uint8Array.from(atob((value as { $b64: string }).$b64), (c) => c.charCodeAt(0))
        : value,
    ) as Frame;
  },
};

/**
 * A node's socket into the cluster — dial the hub (or any relay speaking the same codec)
 * and the `Node` core does the rest: two OS processes, two runtimes, one cluster. Redials
 * with exponential backoff by default (Erlang's automatic reconnect): held frames flush on
 * reopen and the node re-runs its hello handshake via `onReopen`. Pass `reconnect: false`
 * for one-shot sockets.
 *
 * ```ts
 * import { Node } from './node.ts';
 *
 * // Defined, not invoked: dials a real socket.
 * function join(name: string) {
 *   return Node.start(name, wsTransport('ws://localhost:4369')); // frames ride binary by default
 * }
 * ```
 */
export function wsTransport(
  url: string,
  options: {
    codec?: Codec;
    reconnect?: { minMs?: number; maxMs?: number; factor?: number } | false;
    /**
     * Shared cluster secret (Erlang's magic cookie). When set, the transport answers the hub's
     * join `challenge` with HMAC-SHA-256(secret, nonce) — the secret never crosses the wire. A hub
     * started WITHOUT a secret never challenges, so this is inert there; a hub started WITH one drops
     * any socket that can't prove the cookie. Use a `wss://` URL to encrypt the whole channel.
     */
    secret?: string;
  } = {},
): Transport {
  const codec = options.codec ?? binaryCodec;
  const secret = options.secret;
  const reconnect =
    options.reconnect === false
      ? null
      : { minMs: 250, maxMs: 5000, factor: 2, ...(options.reconnect ?? {}) };
  let socket!: WebSocket;
  let handler: ((frame: Frame) => void) | undefined;
  let reopened: (() => void) | undefined;
  const queue: Frame[] = [];
  let closed = false;
  let everOpened = false;
  let delay = reconnect?.minMs ?? 0;

  const dial = (): void => {
    socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => {
      const isReopen = everOpened;
      everOpened = true;
      delay = reconnect?.minMs ?? 0; // a good connection resets the backoff
      for (const frame of queue.splice(0)) socket.send(codec.encode(frame));
      if (isReopen) reopened?.(); // the node re-hellos here — Erlang's re-handshake
    });
    socket.addEventListener('message', (event: MessageEvent) => {
      const data =
        event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : String(event.data);
      const frame = codec.decode(data);
      // Answer a join challenge in the transport layer — the node core never sees auth frames. The
      // digest proves the cookie without revealing it; `from` is unused (the hub keys auth by socket).
      if (frame.kind === 'challenge' && secret) {
        void authDigest(secret, frame.nonce ?? '').then((digest) =>
          socket.send(codec.encode({ kind: 'auth', from: '', nonce: frame.nonce, digest })),
        );
        return;
      }
      handler?.(frame);
    });
    socket.addEventListener('error', () => {}); // close always follows; keep it un-thrown
    socket.addEventListener('close', () => {
      if (closed || !reconnect) return;
      setTimeout(dial, delay); // exponential backoff redial
      delay = Math.min(delay * reconnect.factor, reconnect.maxMs);
    });
  };
  dial();

  return {
    send(frame) {
      if (socket.readyState === WebSocket.OPEN) socket.send(codec.encode(frame));
      else queue.push(frame); // held across the outage, flushed on reopen
    },
    onFrame(h) {
      handler = h;
    },
    onReopen(cb) {
      reopened = cb;
    },
    close() {
      closed = true;
      socket.close();
    },
  };
}

/**
 * Wraps a transport to observe every frame in and out — Erlang's `:dbg` seam, toggled like a
 * flag. Pure passthrough; `onFrame(direction, frame)` sees a structured clone-safe copy for
 * logging, recording, or a live trace view. Compose it around any transport.
 *
 * ```ts
 * import { memoryHub } from './node.ts';
 *
 * const log: string[] = [];
 * const hub = memoryHub();
 * const traced = traceTransport(hub.transport(), (dir, frame) => log.push(`${dir}:${frame.kind}`));
 * traced.send({ kind: 'hello', from: 'a@traced' });
 * log; // ['out:hello']
 * ```
 */
export function traceTransport(
  inner: Transport,
  onFrame: (direction: 'in' | 'out', frame: Frame) => void,
): Transport {
  return {
    send(frame) {
      onFrame('out', frame);
      inner.send(frame);
    },
    onFrame(handler) {
      inner.onFrame((frame) => {
        onFrame('in', frame);
        handler(frame);
      });
    },
    onReopen: inner.onReopen ? (cb) => inner.onReopen!(cb) : undefined,
    close: inner.close ? () => inner.close!() : undefined,
  };
}
