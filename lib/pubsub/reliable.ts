/**
 * `reliablePubSub` — an **at-least-once** variant of {@link pubsub}. Plain PubSub (like
 * `Phoenix.PubSub`) is fire-and-forget: a dropped broadcast frame is simply lost. This adds a thin
 * reliable-delivery protocol on top, for the cases that need it (a live order book, a presence
 * feed a client reconciles against) without reaching for a full message broker.
 *
 * Each sender numbers its messages per topic (a monotonic `seq`) and keeps a bounded buffer of
 * recent ones. A receiver delivers **in order** and **de-duplicated**: on a gap it holds the
 * out-of-order message and asks the sender to **replay** the missing range; a periodic **heartbeat**
 * of the sender's latest `seq` lets a receiver notice a lost *tail* (the last message, with nothing
 * after it to reveal the gap). Reliability is bounded by the buffer — a receiver that falls further
 * behind than `bufferSize` is told to skip (the loss is surfaced, never a silent stall).
 *
 * A late subscriber is reliable from its subscription point onward, not backfilled from the start.
 * The API matches {@link PubSub}, so it's a drop-in where a topic needs delivery guarantees.
 *
 * ```ts
 * import { start, memoryHub } from '../node/index.ts';
 * const node = start('n@rps', memoryHub().transport());
 * const rps = reliablePubSub(node, { heartbeatMs: false });
 * const got: number[] = [];
 * rps.subscribe('ticks', (_e, p) => got.push(p as number));
 * rps.broadcast('ticks', 'tick', 1);
 * await new Promise((r) => setTimeout(r, 10));
 * got; // [1]
 * node.stop();
 * ```
 */
import type { NodeHandle } from '../node/index.ts';
import type { PubSub, PubSubHandler } from './pubsub.ts';

interface Msg {
  topic: string;
  event: string;
  payload: unknown;
  from: string;
  seq: number;
}

const MSG = 'rps.msg';
const REPLAY = 'rps.replay';
const SKIP = 'rps.skip';
const HEARTBEAT = 'rps.hb';
const groupOf = (topic: string) => `rps${topic}`;
const streamKey = (topic: string, from: string) => `${topic}${from}`;

/**
 * Build an at-least-once {@link PubSub} over `node`. `bufferSize` bounds how far a receiver can
 * fall behind and still recover (default 256); `heartbeatMs` is the tail-loss detector interval
 * (default 500; `false` to disable). One per node.
 *
 * ```ts
 * import { start, memoryHub } from '../node/index.ts';
 * const node = start('n@rps2', memoryHub().transport());
 * typeof reliablePubSub(node).broadcast; // 'function'
 * node.stop();
 * ```
 */
export function reliablePubSub(
  node: NodeHandle,
  options: { bufferSize?: number; heartbeatMs?: number | false } = {},
): PubSub {
  const bufferSize = options.bufferSize ?? 256;
  const self = node.self();
  const local = new Map<string, Set<PubSubHandler>>();
  const outSeq = new Map<string, number>(); // my next seq per topic
  const outBuf = new Map<string, Map<number, Msg>>(); // my recent sent msgs per topic
  const inNext = new Map<string, number>(); // next expected seq per (topic,sender)
  const inPending = new Map<string, Map<number, Msg>>(); // held out-of-order msgs

  const deliver = (msg: Msg): void => {
    const subs = local.get(msg.topic);
    if (subs) for (const handler of [...subs]) handler(msg.event, msg.payload);
  };

  // Deliver an in-order message, then flush any contiguous held ones.
  const accept = (key: string, msg: Msg): void => {
    deliver(msg);
    let next = msg.seq + 1;
    const pending = inPending.get(key);
    while (pending?.has(next)) {
      deliver(pending.get(next)!);
      pending.delete(next);
      next++;
    }
    inNext.set(key, next);
  };

  const requestReplay = (topic: string, from: string, fromSeq: number, toSeq: number): void => {
    const seqs: number[] = [];
    for (let s = fromSeq; s <= toSeq; s++) seqs.push(s);
    node.cast(from, REPLAY, { topic, to: self, seqs });
  };

  const onMsg = (msg: Msg): void => {
    if (msg.from === self) return; // my own messages are delivered locally at broadcast time
    const key = streamKey(msg.topic, msg.from);
    const next = inNext.get(key);
    if (next === undefined) return accept(key, msg); // first seen from this sender = baseline
    if (msg.seq < next) return; // duplicate/old — de-dup
    if (msg.seq === next) return accept(key, msg);
    // gap: hold it and ask the sender to replay [next .. seq-1]
    (inPending.get(key) ?? inPending.set(key, new Map()).get(key)!).set(msg.seq, msg);
    requestReplay(msg.topic, msg.from, next, msg.seq - 1);
  };

  node.handle(MSG, (raw) => onMsg(raw as Msg));
  node.handle(REPLAY, (raw) => {
    const req = raw as { topic: string; to: string; seqs: number[] };
    const buf = outBuf.get(req.topic);
    for (const seq of req.seqs) {
      const msg = buf?.get(seq);
      if (msg) node.cast(req.to, MSG, msg);
      else node.cast(req.to, SKIP, { topic: req.topic, from: self, seq }); // evicted — let them advance
    }
  });
  node.handle(SKIP, (raw) => {
    const s = raw as { topic: string; from: string; seq: number };
    const key = streamKey(s.topic, s.from);
    const next = inNext.get(key);
    if (next === undefined || s.seq < next) return;
    // Treat the unrecoverable seq as delivered so ordering can advance past the hole.
    accept(key, {
      topic: s.topic,
      event: '__skip__',
      payload: undefined,
      from: s.from,
      seq: s.seq,
    });
  });
  node.handle(HEARTBEAT, (raw) => {
    const hb = raw as { topic: string; from: string; latest: number };
    if (hb.from === self) return;
    const key = streamKey(hb.topic, hb.from);
    const next = inNext.get(key);
    if (next !== undefined && hb.latest >= next) requestReplay(hb.topic, hb.from, next, hb.latest);
  });

  let hbTimer: ReturnType<typeof setInterval> | undefined;
  if (options.heartbeatMs !== false) {
    hbTimer = setInterval(() => {
      for (const [topic, seq] of outSeq)
        node.cast(`group:${groupOf(topic)}`, HEARTBEAT, { topic, from: self, latest: seq });
    }, options.heartbeatMs ?? 500);
    (hbTimer as { unref?: () => void }).unref?.();
  }

  const unsubscribe = (topic: string, handler: PubSubHandler): void => {
    const subs = local.get(topic);
    if (!subs) return;
    subs.delete(handler);
    if (subs.size === 0) {
      local.delete(topic);
      node.leave(groupOf(topic));
    }
  };

  const send = (topic: string, event: string, payload: unknown, toSelf: boolean): void => {
    const seq = (outSeq.get(topic) ?? 0) + 1;
    outSeq.set(topic, seq);
    const msg: Msg = { topic, event, payload, from: self, seq };
    const buf = outBuf.get(topic) ?? outBuf.set(topic, new Map()).get(topic)!;
    buf.set(seq, msg);
    if (buf.size > bufferSize) buf.delete(seq - bufferSize); // evict oldest
    if (toSelf) deliver(msg); // reach my own subscribers immediately (no self round-trip)
    node.cast(`group:${groupOf(topic)}`, MSG, msg); // others receive + order + de-dup
  };

  return {
    subscribe(topic, handler) {
      let subs = local.get(topic);
      if (!subs) {
        subs = new Set();
        local.set(topic, subs);
        node.join(groupOf(topic));
      }
      subs.add(handler);
      return () => unsubscribe(topic, handler);
    },
    unsubscribe,
    broadcast: (topic, event, payload) => send(topic, event, payload, true),
    broadcastFrom: (topic, event, payload) => send(topic, event, payload, false),
  };
}
