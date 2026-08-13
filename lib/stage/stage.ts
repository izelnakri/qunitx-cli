/**
 * `Stage` — Elixir's **GenStage**: demand-driven, backpressured pipelines of producers and
 * consumers. Where a `Stream` is one lazy, single-consumer pull, a Stage is a live network:
 * a producer can **fan out** to many consumers that each pull at their own rate, events that
 * arrive with no demand **buffer** instead of overrunning a slow consumer, and demand flows
 * upstream as a first-class signal — so a slow consumer throttles a fast producer without a
 * dropped event or an unbounded queue. This is the OTP answer to "performant under load".
 *
 * The three roles mirror GenStage exactly:
 *  - **producer** — a source. `push`ed events (or a `handleDemand` pull callback) are dispatched
 *    only up to the demand its consumers have asked for; the rest wait in the buffer.
 *  - **consumer** — a sink. It subscribes with a `[min, max]` demand window, hands each batch to
 *    `handleEvents` (which may be async — that latency IS the backpressure), and re-asks only when
 *    its outstanding demand falls to `min`, so demand travels in `max - min` chunks.
 *  - **producerConsumer** — both: it consumes, transforms in `handleEvents`, and re-emits
 *    downstream, so stages compose into a chain that is backpressured end to end.
 *
 * ```ts
 * const out: number[] = [];
 * const src = producer<number>();
 * const sink = consumer<number>({ handleEvents: (batch) => void out.push(...batch), max: 2 });
 * sink.subscribe(src);
 * src.push(1, 2, 3);
 * await tick(); // let demand + delivery settle
 * out; // [1, 2, 3]
 * src.stop();
 * ```
 */

/** A batch of events handed across a subscription — always delivered whole to `handleEvents`. */
export type Events<T> = readonly T[];

/**
 * Await the microtask turns a demand round-trip takes — a small helper for doctests and tests
 * that need delivery and re-demand to settle before asserting.
 *
 * ```ts
 * const src = producer<number>();
 * const seen: number[] = [];
 * consumer<number>({ handleEvents: (b) => void seen.push(...b) }).subscribe(src);
 * src.push(1);
 * await tick();
 * seen; // [1]
 * src.stop();
 * ```
 */
export const tick = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

/** The demand-facing side of a consumer, as a producer's dispatcher sees it. */
interface Subscriber<T> {
  deliver(events: Events<T>): void | Promise<void>;
}

/**
 * How a producer splits its events across subscribers. `demand` (the default) routes each event
 * to a subscriber that has outstanding demand (round-robin) — a work-sharing fan-out; `broadcast`
 * gives every subscriber every event, pacing to the slowest. Mirrors GenStage's dispatchers.
 */
export type DispatcherKind = 'demand' | 'broadcast';

interface Registration<T> {
  subscriber: Subscriber<T>;
  demand: number;
}

// The dispatcher owns per-subscriber demand and decides who gets which events. `dispatch` returns
// the events it could NOT place (no demand) so the producer can re-buffer them.
class Dispatcher<T> {
  #kind: DispatcherKind;
  #regs: Registration<T>[] = [];
  #cursor = 0;
  constructor(kind: DispatcherKind) {
    this.#kind = kind;
  }
  add(subscriber: Subscriber<T>): void {
    this.#regs.push({ subscriber, demand: 0 });
  }
  remove(subscriber: Subscriber<T>): void {
    this.#regs = this.#regs.filter((r) => r.subscriber !== subscriber);
  }
  ask(subscriber: Subscriber<T>, n: number): void {
    const reg = this.#regs.find((r) => r.subscriber === subscriber);
    if (reg) reg.demand += n;
  }
  get totalDemand(): number {
    return this.#kind === 'broadcast'
      ? this.#regs.length === 0
        ? 0
        : Math.min(...this.#regs.map((r) => r.demand))
      : this.#regs.reduce((sum, r) => sum + r.demand, 0);
  }
  dispatch(events: T[]): T[] {
    if (this.#regs.length === 0) return events;
    return this.#kind === 'broadcast' ? this.#broadcast(events) : this.#byDemand(events);
  }
  // Every subscriber gets every event, paced to the slowest: only send as many as ALL can take.
  #broadcast(events: T[]): T[] {
    const n = Math.min(events.length, this.totalDemand);
    if (n === 0) return events;
    const batch = events.slice(0, n);
    for (const reg of this.#regs) {
      reg.demand -= n;
      void reg.subscriber.deliver(batch);
    }
    return events.slice(n);
  }
  // Round-robin each event to a subscriber that still has demand — work sharing.
  #byDemand(events: T[]): T[] {
    const batches = new Map<Registration<T>, T[]>();
    let i = 0;
    for (; i < events.length && this.totalDemand > 0; i++) {
      let hops = 0;
      while (this.#regs[this.#cursor % this.#regs.length].demand === 0) {
        this.#cursor++;
        if (++hops > this.#regs.length) break;
      }
      const reg = this.#regs[this.#cursor % this.#regs.length];
      this.#cursor++;
      reg.demand--;
      (batches.get(reg) ?? batches.set(reg, []).get(reg)!).push(events[i]);
    }
    for (const [reg, batch] of batches) void reg.subscriber.deliver(batch);
    return events.slice(i);
  }
}

/** A running producer stage — see {@link producer}. */
export interface Producer<T> {
  /** Emit events; any beyond current demand buffer until a consumer asks. */
  push(...events: T[]): void;
  /** Buffered events not yet dispatched (awaiting demand). */
  readonly buffered: number;
  /** Internal: a consumer registers its demand-facing side here (called by `subscribe`). */
  _attach(subscriber: Subscriber<T>): void;
  /** Internal: a consumer unregisters (called by the `subscribe` un-subscriber). */
  _detach(subscriber: Subscriber<T>): void;
  /** Internal: a consumer opens `n` units of demand (called by the consumer loop). */
  _ask(subscriber: Subscriber<T>, n: number): void;
  /** Drop all subscribers and buffered events. */
  stop(): void;
}

/**
 * A producer stage. `push` events in; they dispatch to subscribers only up to the demand they've
 * asked for and otherwise buffer. Supply `handleDemand` for a PULL source: it's called with the
 * outstanding demand whenever the buffer can't satisfy it, and whatever it returns is pushed.
 *
 * ```ts
 * // A pull producer that generates on demand — never races ahead of its consumer.
 * let next = 0;
 * const counter = producer<number>({ handleDemand: (n) => Array.from({ length: n }, () => next++) });
 * const seen: number[] = [];
 * consumer<number>({ handleEvents: (b) => void seen.push(...b), max: 3 }).subscribe(counter);
 * await tick();
 * seen; // [0, 1, 2] — exactly max, not more
 * counter.stop();
 * ```
 */
export function producer<T>(
  opts: { dispatcher?: DispatcherKind; handleDemand?: (demand: number) => T[] } = {},
): Producer<T> {
  const dispatcher = new Dispatcher<T>(opts.dispatcher ?? 'demand');
  let buffer: T[] = [];
  let stopped = false;

  const flush = (): void => {
    // Pull more from the source if the buffer can't cover outstanding demand.
    if (opts.handleDemand && buffer.length < dispatcher.totalDemand) {
      const want = dispatcher.totalDemand - buffer.length;
      buffer.push(...opts.handleDemand(want));
    }
    if (buffer.length > 0) buffer = dispatcher.dispatch(buffer);
  };

  return {
    push(...events) {
      if (stopped) return;
      buffer.push(...events);
      flush();
    },
    get buffered() {
      return buffer.length;
    },
    _attach: (subscriber) => dispatcher.add(subscriber),
    _detach: (subscriber) => dispatcher.remove(subscriber),
    _ask(subscriber, n) {
      if (stopped) return;
      dispatcher.ask(subscriber, n);
      flush();
    },
    stop() {
      stopped = true;
      buffer = [];
    },
  };
}

/** A running consumer stage — see {@link consumer}. */
export interface Consumer<T> {
  /** Subscribe to a producer and open demand — begins pulling its `[min, max]` window. */
  subscribe(from: Producer<T>): () => void;
}

// The shared consumer loop: keep outstanding demand in [min, max], handle each batch (async
// latency = backpressure), and re-ask (max - outstanding) only once demand falls to min, so
// demand travels in max-min chunks. `onEvents` is where a plain sink handles and a
// producer_consumer transforms + forwards.
function consumerLoop<T>(
  from: Producer<T>,
  min: number,
  max: number,
  onEvents: (events: Events<T>) => void | Promise<void>,
): () => void {
  let outstanding = 0;
  const subscriber: Subscriber<T> = {
    async deliver(events) {
      outstanding -= events.length;
      await onEvents(events);
      if (outstanding <= min) {
        const ask = max - outstanding;
        outstanding += ask;
        from._ask(subscriber, ask);
      }
    },
  };
  from._attach(subscriber);
  outstanding = max;
  from._ask(subscriber, max);
  return () => from._detach(subscriber);
}

/**
 * A consumer stage. It subscribes to producers and hands each batch to `handleEvents`, which may
 * be async — that latency is the backpressure, since the next demand is not asked until it
 * resolves. `max` is the most it will have outstanding; `min` (default 0) is the low-water mark
 * that triggers a refill, so demand travels in `max - min` chunks.
 *
 * ```ts
 * const src = producer<string>();
 * const seen: string[] = [];
 * const sink = consumer<string>({ handleEvents: async (b) => void seen.push(...b), max: 10 });
 * sink.subscribe(src);
 * src.push('a', 'b');
 * await tick();
 * seen; // ['a', 'b']
 * src.stop();
 * ```
 */
export function consumer<T>(opts: {
  handleEvents: (events: Events<T>) => void | Promise<void>;
  min?: number;
  max?: number;
}): Consumer<T> {
  const max = opts.max ?? 1000;
  const min = opts.min ?? 0;
  return {
    subscribe: (from) => consumerLoop(from, min, max, opts.handleEvents),
  };
}

/** A running producer-consumer stage — both a {@link Consumer} and a {@link Producer}. */
export type ProducerConsumer<In, Out> = Consumer<In> & Producer<Out>;

/**
 * A producer-consumer stage: it consumes upstream, transforms each batch through `handleEvents`,
 * and re-emits the result downstream — so a chain `producer → producerConsumer → consumer` is
 * backpressured end to end (downstream demand gates the middle, which gates the source).
 *
 * ```ts
 * const src = producer<number>();
 * const doubler = producerConsumer<number, number>({ handleEvents: (b) => b.map((n) => n * 2) });
 * const out: number[] = [];
 * doubler.subscribe(src);
 * consumer<number>({ handleEvents: (b) => void out.push(...b) }).subscribe(doubler);
 * src.push(1, 2, 3);
 * await tick();
 * await tick();
 * out; // [2, 4, 6]
 * src.stop();
 * ```
 */
export function producerConsumer<In, Out>(opts: {
  handleEvents: (events: Events<In>) => Out[] | Promise<Out[]>;
  dispatcher?: DispatcherKind;
  min?: number;
  max?: number;
}): ProducerConsumer<In, Out> {
  const max = opts.max ?? 1000;
  const min = opts.min ?? 0;
  const out = producer<Out>({ dispatcher: opts.dispatcher });
  // Delegate the producer side explicitly — spreading `out` would freeze its `buffered` getter.
  return {
    push: (...events) => out.push(...events),
    get buffered() {
      return out.buffered;
    },
    _attach: (subscriber) => out._attach(subscriber),
    _detach: (subscriber) => out._detach(subscriber),
    _ask: (subscriber, n) => out._ask(subscriber, n),
    stop: () => out.stop(),
    subscribe: (from) =>
      consumerLoop(from, min, max, async (events) =>
        out.push(...(await opts.handleEvents(events))),
      ),
  };
}
