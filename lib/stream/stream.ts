/**
 * `Stream<T, E>` — the third leg of the error system: many outcomes over time, where
 * `Result` is one settled outcome and `Task` is one future outcome (Elixir's Stream/Flow to
 * Task's Task). The failure vocabulary is shared, not new:
 *
 *  - **Elements are the bare union `T | E`** — a declared per-element failure flows through
 *    the pipeline as a value, exactly like a `Result`.
 *  - **Transforms act on values and let failures pass untouched** — the railway, per element.
 *  - **A bug (any throw) rejects the consuming Task** — the two-tier rule holds: nothing
 *    boxes a `TypeError` into the element flow.
 *  - **Terminal consumers return Tasks**, so completion plugs into `result()`/`match` and the
 *    observation seam like every other async outcome.
 *
 * Streams are lazy and pull-based: nothing runs until a consumer iterates, and sources are
 * only pulled as fast as the consumer takes elements (natural backpressure). A Stream built
 * `from` a re-iterable source (array, generator *function*) can be consumed again; one built
 * from a one-shot source (a `ReadableStream`, a live generator) is one-shot itself.
 *
 * ```ts
 * import * as Failure from '../result/failure.ts';
 *
 * const BadRow = Failure.define('BadRow', (d: { line: number }) => `bad row ${d.line}`);
 * const parsed = Stream.from(['{"id":1}', 'nope', '{"id":3}']).map((raw, n) => {
 *   try {
 *     return JSON.parse(raw) as { id: number };
 *   } catch {
 *     return BadRow({ line: n + 1 });
 *   }
 * });
 *
 * const { values, errors } = await parsed.partition();
 * values.map((row) => row.id); // [1, 3]
 * errors.map((failure) => failure.data.line); // [2]
 * ```
 */
import {
  Failure,
  define,
  isFailure,
  observed,
  type Any as AnyFailure,
  type FailureFactory,
  type Of,
} from '../result/failure.ts';
import { Task } from '../task/task.ts';
import { partition, type Result } from '../result/result.ts';

/** Anything a Stream can be built from or flattened into: sync or async iterables (a web `ReadableStream` is async-iterable on every modern runtime). */
export type Source<T> = AsyncIterable<T> | Iterable<T>;

/**
 * What a full channel does — the two GenStage `:buffer_keep` choices, named for the element that
 * goes rather than the one that stays, plus the option of refusing to lose anything silently.
 *
 * ```ts
 * const keepNewest: Overflow = 'dropOldest'; // GenStage's :last, and the default
 * const keepOldest: Overflow = 'dropNewest'; // GenStage's :first
 * const refuse: Overflow = 'fail';           // stop the stream instead of dropping
 * ```
 */
export type Overflow = 'dropOldest' | 'dropNewest' | 'fail';

/**
 * A channel with `overflow: 'fail'` filled up: the consumer fell far enough behind that the
 * buffer could not hold the difference, and dropping was not on the table.
 *
 * A declared failure rather than a throw, because it is an expected operating condition of a
 * producer nobody can slow down — the two-tier rule puts it in the flow, not in the bug tier.
 *
 * ```ts
 * ChannelOverflow({ capacity: 1_000 }).code; // 'ChannelOverflow'
 * ```
 */
export const ChannelOverflow: FailureFactory<'ChannelOverflow', { capacity: number }> = define(
  'ChannelOverflow',
  (data: { capacity: number }) =>
    `channel overflowed: ${data.capacity} buffered and the consumer did not keep up`,
);

/**
 * The failure element a `'fail'` channel ends with.
 *
 * ```ts
 * const failure: ChannelOverflowFailure = ChannelOverflow({ capacity: 10 });
 * failure.data.capacity; // 10
 * ```
 */
export type ChannelOverflowFailure = Of<typeof ChannelOverflow>;

/**
 * How a {@link Channel} behaves when its consumer cannot keep up.
 *
 * ```ts
 * const options: ChannelOptions<number> = { capacity: 1_000, overflow: 'dropNewest' };
 * options.capacity; // 1000 — past this, `overflow` decides which element is lost
 * ```
 */
export interface ChannelOptions<T, E = never> {
  /** How many elements to buffer for a consumer that has not taken them yet. Default `10_000`. */
  capacity?: number;
  /**
   * What to do once `capacity` is reached: drop from either end, or `'fail'` — end the stream
   * with a {@link ChannelOverflowFailure} element instead of losing anything quietly.
   * Default `'dropOldest'`.
   */
  overflow?: Overflow;
  /**
   * Called with each element the buffer actually lost, and the depth after the loss. The only
   * place overflow is observable — make it fatal from here by calling `fail` or `abort`.
   */
  onDiscard?: (dropped: T | E, buffered: number) => void;
  /**
   * Called once, when a consumer first attaches. A producer that can defer starting should start
   * here: it is the difference between a buffer that stays near empty and one that races ahead
   * of a consumer that has not arrived.
   */
  onDemand?: () => void;
}

/**
 * The producer half of {@link StreamClass.channel}: emit into it, consume `stream` out of it.
 *
 * ```ts
 * const channel: Channel<string> = Stream.channel<string>();
 * channel.emit('a'); // true — buffered, room to spare
 * channel.buffered; // 1
 * ```
 */
export interface Channel<T, E = never> {
  /** The consuming half. One consumer only; a second pass throws. */
  readonly stream: Stream<T, E>;
  /** Elements buffered for a consumer that has not taken them yet. */
  readonly buffered: number;
  /** How many elements the buffer has lost to overflow. `0` unless a consumer fell behind. */
  readonly dropped: number;
  /** Whether the channel has been closed, aborted, or abandoned by its consumer. */
  readonly closed: boolean;
  /**
   * Offers a value. Returns `false` when there is no room left — Node's `write()` convention:
   * advisory for a producer that can slow down, ignorable for one that cannot.
   */
  emit(value: T): boolean;
  /** Offers a declared failure as an **element** — the railway, not a rejection. */
  fail(error: E): boolean;
  /** Ends the stream once the buffer drains. Idempotent. */
  close(): void;
  /** Rejects the consuming Task with `reason` — the two-tier rule's bug tier. Idempotent. */
  abort(reason: unknown): void;
  /**
   * Resolves once there is room to emit again — Web Streams' `writer.ready`, and the promise
   * form of Node's `'drain'`.
   *
   * Named for the condition it actually reports. It resolves when the buffer is **below
   * capacity**, not when it is empty: with 9 of 10 buffered it resolves immediately, because
   * there is room for a tenth. "Drained" would claim the opposite. It is also awaited in a loop
   * rather than once, so it names a recurring gate, unlike the genuinely final `closed`.
   */
  ready(): Promise<void>;
}

async function* iterate<T>(source: Source<T>): AsyncGenerator<T> {
  yield* source as AsyncIterable<T>;
}

/**
 * The stream pipeline: build with a static (`from`/`unfold`/`lines`), shape with lazy
 * transforms (`map`/`filter`/`flatMap`/`take`), finish with a Task-returning consumer
 * (`collect`/`results`/`partition`/`forEach`) — or `for await` the bare elements directly.
 *
 * ```ts
 * const evens = Stream.from([1, 2, 3, 4]).filter((n) => n % 2 === 0);
 * await evens.map((n) => n * 10).collect(); // [20, 40]
 * ```
 */
class StreamClass<T, E = never> implements AsyncIterable<T | E> {
  /** A thunk, not an iterator: each consumer opens its own pass over the source. */
  #open: () => AsyncGenerator<T | E>;

  private constructor(open: () => AsyncGenerator<T | E>) {
    this.#open = open;
  }

  // ── Builders ─────────────────────────────────────────────────────────────────

  /**
   * Lifts a source into a Stream. Elements that are Failures are the `E` channel from the
   * start; everything else is `T`.
   *
   * ```ts
   * const doubled = await Stream.from([1, 2, 3]).map((n) => n * 2).collect();
   * doubled; // [2, 4, 6]
   * ```
   */
  static from<U>(source: Source<U>): StreamClass<Exclude<U, AnyFailure>, Extract<U, AnyFailure>> {
    return new StreamClass(() => iterate(source)) as StreamClass<
      Exclude<U, AnyFailure>,
      Extract<U, AnyFailure>
    >;
  }

  /**
   * Elixir's `Stream.unfold/2`: grow a lazy stream from a seed. `next(state)` returns
   * `[element, nextState]` to emit and continue, or `null` to end; return `[failure, null]`
   * to emit a declared failure and stop. Nothing runs until a consumer pulls — pagination
   * only fetches the pages the consumer actually reaches.
   *
   * ```ts
   * const countdown = Stream.unfold(3, (n) => (n === 0 ? null : [n, n - 1] as const));
   * await countdown.collect(); // [3, 2, 1]
   * ```
   */
  static unfold<S, U>(
    seed: S,
    next: (state: S) => Promise<readonly [U, S | null] | null> | readonly [U, S | null] | null,
  ): StreamClass<Exclude<U, AnyFailure>, Extract<U, AnyFailure>> {
    return new StreamClass(async function* () {
      for (let state: S | null = seed; state !== null;) {
        const step = await next(state);
        if (step === null) return;
        yield step[0];
        state = step[1];
      }
    }) as StreamClass<Exclude<U, AnyFailure>, Extract<U, AnyFailure>>;
  }

  /**
   * Decodes a byte stream into text lines — the front door for NDJSON, logs, and SSE-ish
   * feeds. Handles multi-byte characters and lines split across chunk boundaries; the final
   * unterminated line is flushed.
   *
   * ```ts
   * const bytes = [new TextEncoder().encode('a\nb'), new TextEncoder().encode('c\nd')];
   * await Stream.lines(bytes).collect(); // ['a', 'bc', 'd']
   * ```
   */
  static lines(bytes: Source<Uint8Array>): StreamClass<string> {
    return new StreamClass<string, never>(async function* () {
      const decoder = new TextDecoder();
      let tail = '';
      for await (const chunk of iterate(bytes)) {
        const text = tail + decoder.decode(chunk, { stream: true });
        const lines = text.split('\n');
        tail = lines.pop()!;
        yield* lines;
      }
      tail += decoder.decode();
      if (tail !== '') yield tail;
    });
  }

  /**
   * Concatenates sources in order — Elixir's `Stream.concat`, variadic.
   *
   * ```ts
   * await Stream.concat([1, 2], [3]).collect(); // [1, 2, 3]
   * ```
   */
  static concat<U>(
    ...sources: Source<U>[]
  ): StreamClass<Exclude<U, AnyFailure>, Extract<U, AnyFailure>> {
    return new StreamClass(async function* () {
      for (const source of sources) yield* iterate(source);
    }) as never;
  }

  /**
   * Repeats a re-iterable source forever — always bound it (`take`, `takeWhile`).
   *
   * ```ts
   * await Stream.cycle([1, 2]).take(5).collect(); // [1, 2, 1, 2, 1]
   * ```
   */
  static cycle<U>(source: Source<U>): StreamClass<Exclude<U, AnyFailure>, Extract<U, AnyFailure>> {
    return new StreamClass(async function* () {
      for (;;) {
        let yielded = false;
        for await (const element of iterate(source)) {
          yielded = true;
          yield element;
        }
        if (!yielded) return; // an empty source must not spin forever
      }
    }) as never;
  }

  /**
   * `seed, fn(seed), fn(fn(seed)), …` — Elixir's `Stream.iterate/2`, infinite.
   *
   * ```ts
   * await Stream.iterate(1, (n) => n * 2).take(4).collect(); // [1, 2, 4, 8]
   * ```
   */
  static iterate<U>(seed: U, fn: (previous: U) => U): StreamClass<U> {
    return new StreamClass<U, never>(async function* () {
      for (let value = seed; ; value = fn(value)) yield value;
    });
  }

  /**
   * Calls `fn` for each pull, forever — Elixir's `Stream.repeatedly/1`.
   *
   * ```ts
   * let n = 0;
   * await Stream.repeatedly(() => ++n).take(3).collect(); // [1, 2, 3]
   * ```
   */
  static repeatedly<U>(fn: () => U | PromiseLike<U>): StreamClass<U> {
    return new StreamClass<U, never>(async function* () {
      for (;;) yield await fn();
    });
  }

  /**
   * `count` copies of one value.
   *
   * ```ts
   * await Stream.duplicate('x', 3).collect(); // ['x', 'x', 'x']
   * ```
   */
  static duplicate<U>(value: U, count: number): StreamClass<U> {
    return new StreamClass<U, never>(async function* () {
      for (let i = 0; i < count; i++) yield value;
    });
  }

  /**
   * The infinite integers `offset, offset + 1, …` — Elixir's `Stream.from_index/1`.
   *
   * ```ts
   * await Stream.fromIndex(10).take(3).collect(); // [10, 11, 12]
   * ```
   */
  static fromIndex(offset = 0): StreamClass<number> {
    return new StreamClass<number, never>(async function* () {
      for (let n = offset; ; n++) yield n;
    });
  }

  /**
   * Zips sources in lockstep, ending at the shortest (Elixir's `Stream.zip`) and closing
   * the longer sources so their cleanup runs. JS divergences: sources are pulled
   * sequentially per slot, and a failure element passes through bare **without consuming**
   * from the other sources — failures cannot pair.
   *
   * ```ts
   * await Stream.zip([1, 2, 3], ['a', 'b']).collect(); // [[1, 'a'], [2, 'b']]
   * ```
   */
  static zip<U extends readonly unknown[]>(
    ...sources: { [K in keyof U]: Source<U[K]> }
  ): StreamClass<{ [K in keyof U]: Exclude<U[K], AnyFailure> }, Extract<U[number], AnyFailure>> {
    return new StreamClass(async function* () {
      const iterators = sources.map((source) => iterate(source));
      try {
        for (;;) {
          const tuple: unknown[] = [];
          for (const iterator of iterators) {
            for (;;) {
              const { value, done } = await iterator.next();
              if (done) return;
              if (!isFailure(value)) {
                tuple.push(value);
                break;
              }
              yield value as never;
            }
          }
          yield tuple as never;
        }
      } finally {
        for (const iterator of iterators) await iterator.return(undefined);
      }
    }) as never;
  }

  /**
   * `zip` plus a combiner — Elixir's `Stream.zip_with`; the tuple arrives spread.
   *
   * ```ts
   * await Stream.zipWith([[1, 2], [10, 20]], (a, b) => a + b).collect(); // [11, 22]
   * ```
   */
  static zipWith<U extends readonly unknown[], R>(
    sources: { [K in keyof U]: Source<U[K]> },
    fn: (...values: { [K in keyof U]: Exclude<U[K], AnyFailure> }) => R,
  ): StreamClass<Exclude<R, AnyFailure>, Extract<U[number] | R, AnyFailure>> {
    return StreamClass.zip<U>(...sources).map((tuple) => fn(...tuple)) as never;
  }

  /**
   * Emits `0, 1, 2, …` every `ms` milliseconds, forever — Elixir's `Stream.interval/1`,
   * on `setTimeout` (universal). Infinite: always bound it.
   *
   * ```ts
   * await Stream.interval(1).take(3).collect(); // [0, 1, 2]
   * ```
   */
  static interval(ms: number): StreamClass<number> {
    return new StreamClass<number, never>(async function* () {
      for (let n = 0; ; n++) {
        await new Promise((resolve) => setTimeout(resolve, ms));
        yield n;
      }
    });
  }

  /**
   * Emits a single `0` after `ms` milliseconds, then ends — Elixir's `Stream.timer/1`.
   *
   * ```ts
   * await Stream.timer(1).collect(); // [0]
   * ```
   */
  static timer(ms: number): StreamClass<number> {
    return StreamClass.interval(ms).take(1);
  }

  /**
   * `unfold` with lifecycle hooks — Elixir's `Stream.resource/3`: `start` runs on first
   * pull, `next` is unfold's step, and `after` ALWAYS runs — normal end, early `take`, or a
   * throw. (Plain generators already get this via `try`/`finally`; `resource` is for when
   * the setup/teardown pair deserves to be explicit.)
   *
   * ```ts
   * const opened: string[] = [];
   * const rows = Stream.resource(
   *   () => (opened.push('open'), { cursor: 0 }),
   *   (db) => (db.cursor < 2 ? ([`row-${db.cursor}`, { cursor: db.cursor + 1 }] as const) : null),
   *   () => void opened.push('close'),
   * );
   * await rows.collect(); // ['row-0', 'row-1'] — and opened is ['open', 'close']
   * ```
   */
  static resource<S, U>(
    start: () => S | PromiseLike<S>,
    next: (state: S) => Promise<readonly [U, S | null] | null> | readonly [U, S | null] | null,
    after: (state: S) => void | PromiseLike<void>,
  ): StreamClass<Exclude<U, AnyFailure>, Extract<U, AnyFailure>> {
    return new StreamClass(async function* () {
      const initial = await start();
      let state: S | null = initial;
      let last: S = initial;
      try {
        while (state !== null) {
          const step = await next(state);
          if (step === null) return;
          yield step[0];
          if (step[1] !== null) last = step[1];
          state = step[1];
        }
      } finally {
        await after(last);
      }
    }) as never;
  }

  /**
   * Elixir's `Task.async_stream/3`, living at its JS-idiomatic home: maps `fn` over the
   * source with at most `maxConcurrency` invocations in flight, lazily — nothing starts
   * until a consumer pulls, and the window refills only as results are taken. Results keep
   * source order by default (`ordered: false` yields completion order — faster when element
   * durations vary). Each element may deadline (`timeoutMs`) into a declared
   * `Failure('AsyncTimeout')` **element** — the railway, not a crash; the element's signal
   * fires so cancellation-aware work stops. A throw from `fn` stays a bug. Failure elements
   * from the source pass through unmapped.
   *
   * ```ts
   * const doubled = await Stream.asyncStream([1, 2, 3, 4], (n) => n * 2, { maxConcurrency: 2 }).collect();
   * doubled; // [2, 4, 6, 8] — at most 2 in flight at any moment
   * ```
   */
  static asyncStream<U, R>(
    source: Source<U>,
    fn: (value: Exclude<U, AnyFailure>, signal: AbortSignal) => R | PromiseLike<R>,
    options: { maxConcurrency?: number; timeoutMs?: number; ordered?: boolean } = {},
  ): StreamClass<Exclude<R, AnyFailure>, Extract<U | R, AnyFailure> | AnyFailure> {
    const { maxConcurrency = 4, timeoutMs, ordered = true } = options;
    const runOne = (element: Exclude<U, AnyFailure>): Promise<unknown> => {
      // Executor form: `fn` needs the signal so `shutdown` below can cancel it. Its result goes
      // to the resolver rather than being returned, because `fn` may answer with a plain value
      // and only a returned *promise* settles a Task on its own.
      const work = new Task<unknown>((resolve, _reject, signal) =>
        resolve(fn(element, signal)),
      ).perform();
      if (timeoutMs === undefined) return Promise.resolve(work);
      return work.yield(timeoutMs).then((settled) => {
        if (settled !== null) return isFailure(settled) ? settled : settled;
        work.shutdown(0).then(
          () => undefined,
          () => undefined,
        );
        return new Failure('AsyncTimeout', `element timed out after ${timeoutMs}ms`, {
          ms: timeoutMs,
        });
      });
    };
    return new StreamClass(async function* () {
      const iterator = iterate(source);
      if (ordered) {
        const inflight: Promise<unknown>[] = [];
        for (;;) {
          while (inflight.length < maxConcurrency) {
            const { value, done } = await iterator.next();
            if (done) break;
            inflight.push(isFailure(value) ? Promise.resolve(value) : runOne(value as never));
          }
          if (inflight.length === 0) return;
          yield (await inflight.shift()!) as never;
        }
      } else {
        // Completion order: race a tagged window, refill as slots free up.
        const window = new Map<number, Promise<[number, unknown]>>();
        let nextId = 0;
        let exhausted = false;
        for (;;) {
          while (!exhausted && window.size < maxConcurrency) {
            const { value, done } = await iterator.next();
            if (done) exhausted = true;
            else {
              const id = nextId++;
              const run = isFailure(value) ? Promise.resolve(value) : runOne(value as never);
              window.set(
                id,
                run.then((out) => [id, out]),
              );
            }
          }
          if (window.size === 0) return;
          const [id, out] = await Promise.race(window.values());
          window.delete(id);
          yield out as never;
        }
      }
    }) as never;
  }

  /**
   * The one **push** source: a handle whose producer emits whenever it likes, and a Stream that
   * consumes what it emitted. Every other builder pulls — `unfold`, `resource` and `iterate` all
   * *ask* for the next element — but the most common real source in JS cannot be asked: an
   * EventEmitter, a WebSocket, `fs.watch`, SSE, a browser running tests.
   *
   * **Backpressure is not on offer for such a producer, so the ruling is explicit.** Node's own
   * adapter assumes the producer is pausable (`events.on(emitter, 'x', { highWaterMark: 2 })`
   * throws `emitter.pause is not a function` on a plain EventEmitter, and without it queues
   * without bound); web streams report `desiredSize` but enforce nothing. GenStage is the one
   * design that makes the caller choose, and this is its `:buffer_size` / `:buffer_keep` pair:
   * buffer up to `capacity`, and past it drop from one end or the other. There is no third
   * option — you cannot have both "no loss" and "bounded memory" from a producer that will not
   * slow down.
   *
   * `onDemand` is what makes the good case reachable: it fires when a consumer actually attaches,
   * so a producer that can defer starting keeps the buffer near empty instead of racing ahead of
   * a consumer that is not there yet. Measured against an unslowable producer of 5000 events,
   * attaching from the first event held the peak buffer at 50 with nothing dropped; attaching
   * 80ms late dropped 2250 at `capacity: 1000`, or held 3650 in memory uncapped.
   *
   * **A consumer attaches when its Task is awaited, not when it is built.** `channel.stream
   * .collect()` returns a lazy Task like every other consumer here, so nothing drains until
   * something awaits it, and everything emitted in the meantime goes to the buffer. That is the
   * module's laziness working as designed rather than an exception to it — but a live producer is
   * where it becomes visible, so `onDemand` is the hook that ties the two together.
   *
   * A producer that *can* slow down should honour `emit`'s return value: `if (!emit(x)) await
   * ready()` moves 200 elements through a buffer of 10 without losing one. Merely yielding to
   * the microtask queue between emits does not — the consumer's own path through the generator
   * costs several turns per element, so it is outrun about three to one and overflows anyway.
   *
   * `fail` puts a declared failure **in the flow** (the railway); `abort` rejects the consuming
   * Task — the two-tier rule, kept. For overflow that must be fatal rather than lossy, call
   * either one from `onDiscard`; that is why there is no third overflow mode, and why the
   * failure type stays whatever you declared instead of widening for a case you may not use.
   *
   * One consumer: the buffer is drained, not replayed, so a second pass would take the elements
   * the first was owed. Opening one is a bug and throws — this being silent is exactly the class
   * of defect a push source should not have.
   *
   * ```ts
   * const channel = Stream.channel<number>();
   * const collected = channel.stream.take(2).collect();
   * channel.emit(1);
   * channel.emit(2);
   * await collected; // [1, 2]
   * ```
   */
  static channel<U, F = never>(
    options: ChannelOptions<U, F> & { overflow: 'fail' },
  ): Channel<U, F | ChannelOverflowFailure>;
  static channel<U, F = never>(options?: ChannelOptions<U, F>): Channel<U, F>;
  static channel<U, F = never>(options: ChannelOptions<U, F> = {}): Channel<U, F> {
    // GenStage's `:buffer_size` default, and its `:buffer_keep :last` — keep the newest, which
    // under a flood are the ones adjacent to whatever the consumer is trying to diagnose.
    const { capacity = 10_000, overflow = 'dropOldest', onDiscard, onDemand } = options;
    const queue: (U | F)[] = [];
    let waiting: ((result: IteratorResult<U | F>) => void) | null = null;
    let roomWaiters: (() => void)[] = [];
    let aborted: { reason: unknown } | null = null;
    let closed = false;
    let opened = false;
    let dropped = 0;

    const releaseRoom = () => {
      if (queue.length >= capacity) return;
      const waiters = roomWaiters;
      roomWaiters = [];
      waiters.forEach((resume) => resume());
    };
    // Wakes a consumer parked on an element that is never going to arrive. It re-reads `closed`
    // and `aborted` itself, so one signal serves both endings.
    const wake = () => {
      const resolve = waiting;
      waiting = null;
      resolve?.({ done: true, value: undefined });
    };
    const push = (element: U | F): boolean => {
      if (closed || aborted) return false;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ done: false, value: element });

        return true;
      }
      if (queue.length >= capacity) {
        dropped++;
        // 'fail' keeps everything already accepted and appends the reason it stopped — so the
        // consumer gets a full prefix plus an explanation, rather than a silently short stream.
        // Deliberately one past `capacity`: the terminal failure is not a buffered element, it
        // is the ending, and refusing to store it would be the one drop that actually matters.
        if (overflow === 'fail') {
          onDiscard?.(element, queue.length);
          queue.push(ChannelOverflow({ capacity }) as unknown as F);
          closed = true;
          releaseRoom();

          return false;
        }
        // 'dropNewest' refuses the arrival; 'dropOldest' evicts the front to make room. Either
        // way `onDiscard` is handed the element that was actually lost, not the one that caused
        // the loss — GenStage's `format_discarded/2`, whose whole use is saying what went.
        if (overflow === 'dropNewest') {
          onDiscard?.(element, queue.length);

          return false;
        }
        const evicted = queue.shift() as U | F;
        queue.push(element);
        onDiscard?.(evicted, queue.length);

        return false;
      }
      queue.push(element);

      return queue.length < capacity;
    };

    const stream = new StreamClass<U, F>(async function* () {
      if (opened) {
        throw new Error(
          'Stream.channel: this stream has already been consumed — a channel buffers for one ' +
            'consumer, so a second pass would take elements the first was owed.',
        );
      }
      opened = true;
      onDemand?.();
      try {
        for (;;) {
          if (queue.length > 0) {
            const element = queue.shift() as U | F;
            releaseRoom();
            yield element;
            continue;
          }
          // Checked with the queue empty, so everything emitted before the ending still reaches
          // the consumer — closing would otherwise be racy from the producer's side.
          if (aborted) throw aborted.reason;
          if (closed) return;

          const next = await new Promise<IteratorResult<U | F>>((resolve) => (waiting = resolve));
          if (!next.done) yield next.value;
        }
      } finally {
        // The consumer left — `take(n)`, a `break`, or a throw downstream. Nothing will drain
        // this buffer again, so stop accepting and release a producer parked on `ready()`
        // rather than leaving it waiting on room that will never be needed.
        closed = true;
        waiting = null;
        queue.length = 0;
        releaseRoom();
      }
    });

    return {
      stream,
      get buffered() {
        return queue.length;
      },
      get dropped() {
        return dropped;
      },
      get closed() {
        return closed || aborted !== null;
      },
      emit: (value: U) => push(value),
      fail: (error: F) => push(error),
      close: () => {
        if (closed || aborted) return;
        closed = true;
        wake();
        releaseRoom();
      },
      abort: (reason: unknown) => {
        if (closed || aborted) return;
        aborted = { reason };
        wake();
        releaseRoom();
      },
      ready: () =>
        queue.length < capacity || closed || aborted !== null
          ? Promise.resolve()
          : new Promise<void>((resume) => void roomWaiters.push(resume)),
    };
  }

  // ── Static mirrors — the same members, source-first ─────────────────────────
  //
  // `Stream.map(source, fn)` IS `Stream.from(source).map(fn)`: one-line delegations, so there is
  // one implementation and the two spellings cannot drift. They exist for the pipe operator —
  // `source |> Stream.map(^, fn) |> Stream.filter(^, ok)` reads left-to-right the way Elixir's
  // `|> Stream.map(fn)` does, which is the whole reason Elixir's API is function-first. Until
  // `|>` lands, chaining is the readable spelling and these nest inside-out; prefer the methods.

  /**
   * {@link StreamClass#map} as a static: `Stream.map(source, …)` is
   * `Stream.from(source).map(…)`.
   *
   * ```ts
   * await Stream.map([1, 2], (n) => n * 2).collect(); // [2, 4]
   * ```
   */
  static map<S, U>(
    source: Source<S>,
    fn: (value: Exclude<S, AnyFailure>, index: number) => U | PromiseLike<U>,
  ): StreamClass<Exclude<U, AnyFailure>, Extract<S, AnyFailure> | Extract<U, AnyFailure>> {
    return StreamClass.from(source).map(fn) as StreamClass<
      Exclude<U, AnyFailure>,
      Extract<S, AnyFailure> | Extract<U, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#filter} as a static: `Stream.filter(source, …)` is
   * `Stream.from(source).filter(…)`.
   *
   * ```ts
   * await Stream.filter([1, 2, 3], (n) => n % 2 === 1).collect(); // [1, 3]
   * ```
   */
  static filter<S>(
    source: Source<S>,
    predicate: (value: Exclude<S, AnyFailure>, index: number) => boolean,
  ): StreamClass<Exclude<S, AnyFailure>, Extract<S, AnyFailure>> {
    return StreamClass.from(source).filter(predicate) as StreamClass<
      Exclude<S, AnyFailure>,
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#reject} as a static: `Stream.reject(source, …)` is
   * `Stream.from(source).reject(…)`.
   *
   * ```ts
   * await Stream.reject([1, 2, 3], (n) => n === 2).collect(); // [1, 3]
   * ```
   */
  static reject<S>(
    source: Source<S>,
    predicate: (value: Exclude<S, AnyFailure>, index: number) => boolean,
  ): StreamClass<Exclude<S, AnyFailure>, Extract<S, AnyFailure>> {
    return StreamClass.from(source).reject(predicate) as StreamClass<
      Exclude<S, AnyFailure>,
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#flatMap} as a static: `Stream.flatMap(source, …)` is
   * `Stream.from(source).flatMap(…)`.
   *
   * ```ts
   * await Stream.flatMap([1, 2], (n) => [n, n]).collect(); // [1, 1, 2, 2]
   * ```
   */
  static flatMap<S, U>(
    source: Source<S>,
    fn: (value: Exclude<S, AnyFailure>, index: number) => Source<U>,
  ): StreamClass<Exclude<U, AnyFailure>, Extract<S, AnyFailure> | Extract<U, AnyFailure>> {
    return StreamClass.from(source).flatMap(fn) as StreamClass<
      Exclude<U, AnyFailure>,
      Extract<S, AnyFailure> | Extract<U, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#take} as a static: `Stream.take(source, …)` is
   * `Stream.from(source).take(…)`.
   *
   * ```ts
   * await Stream.take([1, 2, 3], 2).collect(); // [1, 2]
   * ```
   */
  static take<S>(
    source: Source<S>,
    count: number,
  ): StreamClass<Exclude<S, AnyFailure>, Extract<S, AnyFailure>> {
    return StreamClass.from(source).take(count) as StreamClass<
      Exclude<S, AnyFailure>,
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#drop} as a static: `Stream.drop(source, …)` is
   * `Stream.from(source).drop(…)`.
   *
   * ```ts
   * await Stream.drop([1, 2, 3], 1).collect(); // [2, 3]
   * ```
   */
  static drop<S>(
    source: Source<S>,
    count: number,
  ): StreamClass<Exclude<S, AnyFailure>, Extract<S, AnyFailure>> {
    return StreamClass.from(source).drop(count) as StreamClass<
      Exclude<S, AnyFailure>,
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#takeWhile} as a static: `Stream.takeWhile(source, …)` is
   * `Stream.from(source).takeWhile(…)`.
   *
   * ```ts
   * await Stream.takeWhile([1, 2, 3], (n) => n < 3).collect(); // [1, 2]
   * ```
   */
  static takeWhile<S>(
    source: Source<S>,
    predicate: (value: Exclude<S, AnyFailure>, index: number) => boolean,
  ): StreamClass<Exclude<S, AnyFailure>, Extract<S, AnyFailure>> {
    return StreamClass.from(source).takeWhile(predicate) as StreamClass<
      Exclude<S, AnyFailure>,
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#dropWhile} as a static: `Stream.dropWhile(source, …)` is
   * `Stream.from(source).dropWhile(…)`.
   *
   * ```ts
   * await Stream.dropWhile([1, 2, 3], (n) => n < 3).collect(); // [3]
   * ```
   */
  static dropWhile<S>(
    source: Source<S>,
    predicate: (value: Exclude<S, AnyFailure>, index: number) => boolean,
  ): StreamClass<Exclude<S, AnyFailure>, Extract<S, AnyFailure>> {
    return StreamClass.from(source).dropWhile(predicate) as StreamClass<
      Exclude<S, AnyFailure>,
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#takeEvery} as a static: `Stream.takeEvery(source, …)` is
   * `Stream.from(source).takeEvery(…)`.
   *
   * ```ts
   * await Stream.takeEvery([1, 2, 3, 4], 2).collect(); // [1, 3]
   * ```
   */
  static takeEvery<S>(
    source: Source<S>,
    every: number,
  ): StreamClass<Exclude<S, AnyFailure>, Extract<S, AnyFailure>> {
    return StreamClass.from(source).takeEvery(every) as StreamClass<
      Exclude<S, AnyFailure>,
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#dropEvery} as a static: `Stream.dropEvery(source, …)` is
   * `Stream.from(source).dropEvery(…)`.
   *
   * ```ts
   * await Stream.dropEvery([1, 2, 3, 4], 2).collect(); // [2, 4]
   * ```
   */
  static dropEvery<S>(
    source: Source<S>,
    every: number,
  ): StreamClass<Exclude<S, AnyFailure>, Extract<S, AnyFailure>> {
    return StreamClass.from(source).dropEvery(every) as StreamClass<
      Exclude<S, AnyFailure>,
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#mapEvery} as a static: `Stream.mapEvery(source, …)` is
   * `Stream.from(source).mapEvery(…)`.
   *
   * ```ts
   * await Stream.mapEvery([1, 2, 3, 4], 2, (n) => n * 10).collect(); // [10, 2, 30, 4]
   * ```
   */
  static mapEvery<S>(
    source: Source<S>,
    every: number,
    fn: (
      value: Exclude<S, AnyFailure>,
    ) => Exclude<S, AnyFailure> | PromiseLike<Exclude<S, AnyFailure>>,
  ): StreamClass<Exclude<S, AnyFailure>, Extract<S, AnyFailure>> {
    return StreamClass.from(source).mapEvery(every, fn) as StreamClass<
      Exclude<S, AnyFailure>,
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#withIndex} as a static: `Stream.withIndex(source, …)` is
   * `Stream.from(source).withIndex(…)`.
   *
   * ```ts
   * await Stream.withIndex(['a', 'b']).collect(); // [['a', 0], ['b', 1]]
   * ```
   */
  static withIndex<S>(
    source: Source<S>,
    offset = 0,
  ): StreamClass<readonly [Exclude<S, AnyFailure>, number], Extract<S, AnyFailure>> {
    return StreamClass.from(source).withIndex(offset) as StreamClass<
      readonly [Exclude<S, AnyFailure>, number],
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#intersperse} as a static: `Stream.intersperse(source, …)` is
   * `Stream.from(source).intersperse(…)`.
   *
   * ```ts
   * await Stream.intersperse([1, 2], 0).collect(); // [1, 0, 2]
   * ```
   */
  static intersperse<S, Sep>(
    source: Source<S>,
    separator: Sep,
  ): StreamClass<Exclude<S, AnyFailure> | Sep, Extract<S, AnyFailure>> {
    return StreamClass.from(source).intersperse(separator) as StreamClass<
      Exclude<S, AnyFailure> | Sep,
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#dedup} as a static: `Stream.dedup(source, …)` is
   * `Stream.from(source).dedup(…)`.
   *
   * ```ts
   * await Stream.dedup([1, 1, 2, 1]).collect(); // [1, 2, 1]
   * ```
   */
  static dedup<S>(source: Source<S>): StreamClass<Exclude<S, AnyFailure>, Extract<S, AnyFailure>> {
    return StreamClass.from(source).dedup() as StreamClass<
      Exclude<S, AnyFailure>,
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#dedupBy} as a static: `Stream.dedupBy(source, …)` is
   * `Stream.from(source).dedupBy(…)`.
   *
   * ```ts
   * await Stream.dedupBy([1, 1, 2], (n) => n).collect(); // [1, 2]
   * ```
   */
  static dedupBy<S>(
    source: Source<S>,
    key: (value: Exclude<S, AnyFailure>) => unknown,
  ): StreamClass<Exclude<S, AnyFailure>, Extract<S, AnyFailure>> {
    return StreamClass.from(source).dedupBy(key) as StreamClass<
      Exclude<S, AnyFailure>,
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#uniq} as a static: `Stream.uniq(source, …)` is
   * `Stream.from(source).uniq(…)`.
   *
   * ```ts
   * await Stream.uniq([1, 1, 2, 1]).collect(); // [1, 2]
   * ```
   */
  static uniq<S>(source: Source<S>): StreamClass<Exclude<S, AnyFailure>, Extract<S, AnyFailure>> {
    return StreamClass.from(source).uniq() as StreamClass<
      Exclude<S, AnyFailure>,
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#uniqBy} as a static: `Stream.uniqBy(source, …)` is
   * `Stream.from(source).uniqBy(…)`.
   *
   * ```ts
   * await Stream.uniqBy([1, 1, 2], (n) => n).collect(); // [1, 2]
   * ```
   */
  static uniqBy<S>(
    source: Source<S>,
    key: (value: Exclude<S, AnyFailure>) => unknown,
  ): StreamClass<Exclude<S, AnyFailure>, Extract<S, AnyFailure>> {
    return StreamClass.from(source).uniqBy(key) as StreamClass<
      Exclude<S, AnyFailure>,
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#tap} as a static: `Stream.tap(source, …)` is
   * `Stream.from(source).tap(…)`.
   *
   * ```ts
   * await Stream.tap([1, 2], () => {}).collect(); // [1, 2]
   * ```
   */
  static tap<S>(
    source: Source<S>,
    fn: (value: Exclude<S, AnyFailure>, index: number) => void | PromiseLike<void>,
  ): StreamClass<Exclude<S, AnyFailure>, Extract<S, AnyFailure>> {
    return StreamClass.from(source).tap(fn) as StreamClass<
      Exclude<S, AnyFailure>,
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#into} as a static: `Stream.into(source, …)` is
   * `Stream.from(source).into(…)`.
   *
   * ```ts
   * await Stream.into([1, 2], new WritableStream()).collect(); // [1, 2]
   * ```
   */
  static into<S>(
    source: Source<S>,
    sink: WritableStream<Exclude<S, AnyFailure>>,
  ): StreamClass<Exclude<S, AnyFailure>, Extract<S, AnyFailure>> {
    return StreamClass.from(source).into(sink) as StreamClass<
      Exclude<S, AnyFailure>,
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#chunkEvery} as a static: `Stream.chunkEvery(source, …)` is
   * `Stream.from(source).chunkEvery(…)`.
   *
   * ```ts
   * await Stream.chunkEvery([1, 2, 3], 2).collect(); // [[1, 2], [3]]
   * ```
   */
  static chunkEvery<S>(
    source: Source<S>,
    count: number,
    step = count,
    leftover: Exclude<S, AnyFailure>[] | 'discard' = [],
  ): StreamClass<Exclude<S, AnyFailure>[], Extract<S, AnyFailure>> {
    return StreamClass.from(source).chunkEvery(count, step, leftover) as StreamClass<
      Exclude<S, AnyFailure>[],
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#chunkBy} as a static: `Stream.chunkBy(source, …)` is
   * `Stream.from(source).chunkBy(…)`.
   *
   * ```ts
   * await Stream.chunkBy([1, 1, 2], (n) => n).collect(); // [[1, 1], [2]]
   * ```
   */
  static chunkBy<S>(
    source: Source<S>,
    key: (value: Exclude<S, AnyFailure>) => unknown,
  ): StreamClass<Exclude<S, AnyFailure>[], Extract<S, AnyFailure>> {
    return StreamClass.from(source).chunkBy(key) as StreamClass<
      Exclude<S, AnyFailure>[],
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#chunkWhile} as a static: `Stream.chunkWhile(source, …)` is
   * `Stream.from(source).chunkWhile(…)`.
   *
   * ```ts
   * await Stream.chunkWhile([1, 2], 0, (v, acc) => ({ acc: acc + v, emit: [v] })).collect(); // [[1], [2]]
   * ```
   */
  static chunkWhile<S, A, C>(
    source: Source<S>,
    initial: A,
    step: (value: Exclude<S, AnyFailure>, accumulator: A) => { acc: A; emit?: C; halt?: boolean },
    flush?: (accumulator: A) => C | undefined,
  ): StreamClass<C, Extract<S, AnyFailure>> {
    return StreamClass.from(source).chunkWhile(initial, step, flush) as StreamClass<
      C,
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#through} as a static: `Stream.through(source, …)` is
   * `Stream.from(source).through(…)`.
   *
   * ```ts
   * await Stream.through([1, 2], async function* (els) { yield* els; }).collect(); // [1, 2]
   * ```
   */
  static through<S, U>(
    source: Source<S>,
    fn: (elements: AsyncIterable<S>) => Source<U>,
  ): StreamClass<Exclude<U, AnyFailure>, Extract<U, AnyFailure>> {
    return StreamClass.from(source).through(fn as never) as StreamClass<
      Exclude<U, AnyFailure>,
      Extract<U, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#mapConcurrent} as a static: `Stream.mapConcurrent(source, …)` is
   * `Stream.from(source).mapConcurrent(…)`.
   *
   * ```ts
   * await Stream.mapConcurrent([1, 2], (n) => n * 2, { maxConcurrency: 2 }).collect(); // [2, 4]
   * ```
   */
  static mapConcurrent<S, R>(
    source: Source<S>,
    fn: (value: Exclude<S, AnyFailure>, signal: AbortSignal) => R | PromiseLike<R>,
    options: { maxConcurrency?: number; timeoutMs?: number; ordered?: boolean } = {},
  ): StreamClass<
    Exclude<R, AnyFailure>,
    Extract<S, AnyFailure> | Extract<R, AnyFailure> | AnyFailure
  > {
    return StreamClass.from(source).mapConcurrent(fn, options) as StreamClass<
      Exclude<R, AnyFailure>,
      Extract<S, AnyFailure> | Extract<R, AnyFailure> | AnyFailure
    >;
  }

  /**
   * {@link StreamClass#collect} as a static: `Stream.collect(source, …)` is
   * `Stream.from(source).collect(…)`.
   *
   * ```ts
   * await Stream.collect([1, 2]); // [1, 2]
   * ```
   */
  static collect<S>(source: Source<S>): Task<Exclude<S, AnyFailure>[], Extract<S, AnyFailure>> {
    return StreamClass.from(source).collect() as Task<
      Exclude<S, AnyFailure>[],
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#results} as a static: `Stream.results(source, …)` is
   * `Stream.from(source).results(…)`.
   *
   * ```ts
   * (await Stream.results([1, 2])).length; // 2
   * ```
   */
  static results<S>(
    source: Source<S>,
  ): Task<Result<Exclude<S, AnyFailure>, Extract<S, AnyFailure>>[], never> {
    return StreamClass.from(source).results() as Task<
      Result<Exclude<S, AnyFailure>, Extract<S, AnyFailure>>[],
      never
    >;
  }

  /**
   * {@link StreamClass#partition} as a static: `Stream.partition(source, …)` is
   * `Stream.from(source).partition(…)`.
   *
   * ```ts
   * (await Stream.partition([1, 2])).values; // [1, 2]
   * ```
   */
  static partition<S>(
    source: Source<S>,
  ): Task<{ values: Exclude<S, AnyFailure>[]; errors: Extract<S, AnyFailure>[] }, never> {
    return StreamClass.from(source).partition() as Task<
      { values: Exclude<S, AnyFailure>[]; errors: Extract<S, AnyFailure>[] },
      never
    >;
  }

  /**
   * {@link StreamClass#reduce} as a static: `Stream.reduce(source, …)` is
   * `Stream.from(source).reduce(…)`.
   *
   * ```ts
   * await Stream.reduce([1, 2, 3], (sum, n) => sum + n, 0); // 6
   * ```
   */
  static reduce<S, A>(
    source: Source<S>,
    fn: (accumulator: A, value: Exclude<S, AnyFailure>, index: number) => A | PromiseLike<A>,
    initial: A,
  ): Task<A, Extract<S, AnyFailure>> {
    return StreamClass.from(source).reduce(fn, initial) as Task<A, Extract<S, AnyFailure>>;
  }

  /**
   * {@link StreamClass#some} as a static: `Stream.some(source, …)` is
   * `Stream.from(source).some(…)`.
   *
   * ```ts
   * await Stream.some([1, 2], (n) => n > 1); // true
   * ```
   */
  static some<S>(
    source: Source<S>,
    predicate: (value: Exclude<S, AnyFailure>, index: number) => boolean | PromiseLike<boolean>,
  ): Task<boolean, Extract<S, AnyFailure>> {
    return StreamClass.from(source).some(predicate) as Task<boolean, Extract<S, AnyFailure>>;
  }

  /**
   * {@link StreamClass#every} as a static: `Stream.every(source, …)` is
   * `Stream.from(source).every(…)`.
   *
   * ```ts
   * await Stream.every([2, 4], (n) => n % 2 === 0); // true
   * ```
   */
  static every<S>(
    source: Source<S>,
    predicate: (value: Exclude<S, AnyFailure>, index: number) => boolean | PromiseLike<boolean>,
  ): Task<boolean, Extract<S, AnyFailure>> {
    return StreamClass.from(source).every(predicate) as Task<boolean, Extract<S, AnyFailure>>;
  }

  /**
   * {@link StreamClass#find} as a static: `Stream.find(source, …)` is
   * `Stream.from(source).find(…)`.
   *
   * ```ts
   * await Stream.find([1, 2], (n) => n > 1); // 2
   * ```
   */
  static find<S>(
    source: Source<S>,
    predicate: (value: Exclude<S, AnyFailure>, index: number) => boolean | PromiseLike<boolean>,
  ): Task<Exclude<S, AnyFailure> | undefined, Extract<S, AnyFailure>> {
    return StreamClass.from(source).find(predicate) as Task<
      Exclude<S, AnyFailure> | undefined,
      Extract<S, AnyFailure>
    >;
  }

  /**
   * {@link StreamClass#forEach} as a static: `Stream.forEach(source, …)` is
   * `Stream.from(source).forEach(…)`.
   *
   * ```ts
   * await Stream.forEach([1, 2], () => {}); // undefined
   * ```
   */
  static forEach<S>(
    source: Source<S>,
    fn: (value: Exclude<S, AnyFailure>, index: number) => void | PromiseLike<void>,
  ): Task<void, Extract<S, AnyFailure>> {
    return StreamClass.from(source).forEach(fn) as Task<void, Extract<S, AnyFailure>>;
  }

  /**
   * {@link StreamClass#run} as a static: `Stream.run(source, …)` is
   * `Stream.from(source).run(…)`.
   *
   * ```ts
   * await Stream.run([1, 2]); // undefined
   * ```
   */
  static run<S>(source: Source<S>): Task<void, Extract<S, AnyFailure>> {
    return StreamClass.from(source).run() as Task<void, Extract<S, AnyFailure>>;
  }

  // ── Transforms — lazy, failures pass through untouched ──────────────────────

  /**
   * {@link StreamClass.asyncStream} as a **stage**: the same bounded fan-out, usable in the
   * middle of a pipeline instead of only at the start of one.
   *
   * ```ts
   * const rows = await Stream.from([1, 2, 3, 4])
   *   .filter((n) => n % 2 === 0)
   *   .mapConcurrent((n) => n * 10, { maxConcurrency: 2 })
   *   .collect();
   * rows; // [20, 40]
   * ```
   *
   * **Why concurrency is a stage rather than a `.limit(n)` you append.** The obvious API is
   * TC39's — `.map(fetch).limit(5)` — and it cannot work on top of async generators. A generator
   * has one suspended body, so it has exactly one resume point, and it serializes `.next()` no
   * matter how many calls are in flight. Measured: a downstream limiter aggressively keeping
   * three `.next()` calls outstanding over a generator-backed `map` of six 40ms elements still
   * took 242ms at peak concurrency 1 — identical to serial. Nothing downstream can parallelise
   * work that upstream has already awaited.
   *
   * So the stage that *performs* the async work is the only place that can introduce
   * concurrency, which is what this is. It is also why TC39's helpers are still unshipped: to
   * make `.limit` composable they must first respecify the helpers as something other than async
   * generators.
   */
  mapConcurrent<R>(
    fn: (value: T, signal: AbortSignal) => R | PromiseLike<R>,
    options: { maxConcurrency?: number; timeoutMs?: number; ordered?: boolean } = {},
  ): StreamClass<Exclude<R, AnyFailure>, E | Extract<R, AnyFailure> | AnyFailure> {
    // Literally `asyncStream` with `this` as the source — a Stream is an AsyncIterable, so the
    // static already accepts it. One grammar, two entry points, no second implementation to
    // drift: whatever the window and ordering rules are, they are the same rules.
    return StreamClass.asyncStream(this, fn as never, options) as never;
  }

  /**
   * Transforms each **value**; failure elements flow past untouched (the railway, per
   * element). `fn` may itself return a Failure — that widens the stream's `E`, which is how
   * a parse step turns raw input into `Row | BadRow` without a wrapper per element. A throw
   * inside `fn` is a bug and rejects the consumer.
   *
   * **`fn` is awaited one element at a time.** `map((url) => fetch(url))` issues its requests
   * strictly in sequence — six 60ms calls take 360ms, not 60ms. That is not an oversight to
   * route around: a stream is one suspended generator, so it has exactly one resume point, and
   * the same constraint is why TC39's async iterator helpers are still unshipped over precisely
   * this question. For concurrent per-element work use {@link StreamClass.asyncStream}, whose
   * `maxConcurrency` bounds the window and whose `ordered` decides whether results keep source
   * order or arrive as they finish.
   *
   * ```ts
   * const tagged = await Stream.from([1, 2]).map((n, i) => `${i}:${n}`).collect();
   * tagged; // ['0:1', '1:2']
   * ```
   */
  map<U>(
    fn: (value: T, index: number) => U | PromiseLike<U>,
  ): StreamClass<Exclude<U, AnyFailure>, E | Extract<U, AnyFailure>> {
    const open = this.#open;
    return new StreamClass(async function* () {
      let index = 0;
      for await (const element of open()) {
        yield isFailure(element) ? element : ((await fn(element as T, index++)) as never);
      }
    }) as never;
  }

  /**
   * Keeps the values `predicate` accepts; failure elements always pass through — dropping a
   * declared failure is a decision for a consumer (`partition`), never a side effect of
   * filtering values.
   *
   * ```ts
   * await Stream.from([1, 2, 3, 4]).filter((n) => n % 2 === 0).collect(); // [2, 4]
   * ```
   */
  filter(predicate: (value: T, index: number) => boolean): StreamClass<T, E> {
    const open = this.#open;
    return new StreamClass<T, E>(async function* () {
      let index = 0;
      for await (const element of open()) {
        if (isFailure(element) || predicate(element as T, index++)) yield element;
      }
    });
  }

  /**
   * Expands each value into a source and flattens it in order — pages into rows, rows into
   * cells. Failure elements pass through unexpanded.
   *
   * ```ts
   * await Stream.from([[1, 2], [3]]).flatMap((page) => page).collect(); // [1, 2, 3]
   * ```
   */
  flatMap<U>(
    fn: (value: T, index: number) => Source<U>,
  ): StreamClass<Exclude<U, AnyFailure>, E | Extract<U, AnyFailure>> {
    const open = this.#open;
    return new StreamClass(async function* () {
      let index = 0;
      for await (const element of open()) {
        if (isFailure(element)) yield element;
        else yield* iterate(fn(element as T, index++));
      }
    }) as never;
  }

  /**
   * Ends the stream after `count` elements (values and failures both count — `take` bounds
   * work, it does not editorialize). The source is never pulled past the cut, which is the
   * whole point over an eager slice: `unfold` pagination stops fetching.
   *
   * ```ts
   * let pulled = 0;
   * const firstTwo = Stream.unfold(0, (n) => ((pulled += 1), [n, n + 1] as const)).take(2);
   * await firstTwo.collect(); // [0, 1] — and pulled is 2, not ∞
   * ```
   */
  take(count: number): StreamClass<T, E> {
    const open = this.#open;
    return new StreamClass<T, E>(async function* () {
      if (count <= 0) return;
      let taken = 0;
      for await (const element of open()) {
        yield element;
        if (++taken >= count) return;
      }
    });
  }

  /**
   * Drops the values `predicate` accepts — `filter`'s complement; failures pass through.
   *
   * ```ts
   * await Stream.from([1, 2, 3, 4]).reject((n) => n % 2 === 0).collect(); // [1, 3]
   * ```
   */
  reject(predicate: (value: T, index: number) => boolean): StreamClass<T, E> {
    return this.filter((value, index) => !predicate(value, index));
  }

  /**
   * Ends the stream at the first value `predicate` refuses. Failures inside the window pass
   * through and are never tested — the predicate speaks about values only.
   *
   * ```ts
   * await Stream.from([1, 2, 9, 1]).takeWhile((n) => n < 5).collect(); // [1, 2]
   * ```
   */
  takeWhile(predicate: (value: T, index: number) => boolean): StreamClass<T, E> {
    const open = this.#open;
    return new StreamClass<T, E>(async function* () {
      let index = 0;
      for await (const element of open()) {
        if (!isFailure(element) && !predicate(element as T, index++)) return;
        yield element;
      }
    });
  }

  /**
   * Discards the first `count` elements — positional like {@link StreamClass#take}, so
   * values and failures both count (dropping a prefix is an explicit consumer decision).
   *
   * ```ts
   * await Stream.from([1, 2, 3, 4]).drop(2).collect(); // [3, 4]
   * ```
   */
  drop(count: number): StreamClass<T, E> {
    const open = this.#open;
    return new StreamClass<T, E>(async function* () {
      let dropped = 0;
      for await (const element of open()) {
        if (dropped < count) dropped++;
        else yield element;
      }
    });
  }

  /**
   * Discards values while `predicate` holds, then everything flows. Failures met during the
   * dropping phase still pass through — a declared failure is never silently swallowed by a
   * value predicate.
   *
   * ```ts
   * await Stream.from([1, 2, 9, 1]).dropWhile((n) => n < 5).collect(); // [9, 1]
   * ```
   */
  dropWhile(predicate: (value: T, index: number) => boolean): StreamClass<T, E> {
    const open = this.#open;
    return new StreamClass<T, E>(async function* () {
      let index = 0;
      let dropping = true;
      for await (const element of open()) {
        if (dropping && !isFailure(element)) dropping = predicate(element as T, index++);
        if (!dropping || isFailure(element)) yield element;
      }
    });
  }

  /**
   * Keeps the values at positions `0, every, 2·every, …` (Elixir's `take_every/2`,
   * counting values; failures pass through). `every` of 0 keeps nothing.
   *
   * ```ts
   * await Stream.from([0, 1, 2, 3, 4]).takeEvery(2).collect(); // [0, 2, 4]
   * ```
   */
  takeEvery(every: number): StreamClass<T, E> {
    const open = this.#open;
    return new StreamClass<T, E>(async function* () {
      if (every <= 0) return;
      let index = 0;
      for await (const element of open()) {
        if (isFailure(element) || index++ % every === 0) yield element;
      }
    });
  }

  /**
   * Drops the values at positions `0, every, 2·every, …` (Elixir's `drop_every/2`,
   * counting values; failures pass through).
   *
   * ```ts
   * await Stream.from([0, 1, 2, 3, 4]).dropEvery(2).collect(); // [1, 3]
   * ```
   */
  dropEvery(every: number): StreamClass<T, E> {
    const open = this.#open;
    return new StreamClass<T, E>(async function* () {
      let index = 0;
      for await (const element of open()) {
        if (isFailure(element)) yield element;
        else if (every <= 0 || index++ % every !== 0) yield element;
      }
    });
  }

  /**
   * Transforms the values at positions `0, every, 2·every, …`, passing the rest — and every
   * failure — through unchanged (Elixir's `map_every/3`).
   *
   * ```ts
   * await Stream.from([1, 1, 1, 1]).mapEvery(2, (n) => n * 10).collect(); // [10, 1, 10, 1]
   * ```
   */
  mapEvery(every: number, fn: (value: T) => T | PromiseLike<T>): StreamClass<T, E> {
    const open = this.#open;
    return new StreamClass<T, E>(async function* () {
      let index = 0;
      for await (const element of open()) {
        if (isFailure(element)) yield element;
        else if (every > 0 && index++ % every === 0) yield (await fn(element as T)) as T;
        else yield element;
      }
    });
  }

  /**
   * Pairs each value with its index: `[value, index]`. Failures pass bare and consume no
   * index — pairs stay contiguous.
   *
   * ```ts
   * await Stream.from(['a', 'b']).withIndex(1).collect(); // [['a', 1], ['b', 2]]
   * ```
   */
  withIndex(offset = 0): StreamClass<readonly [T, number], E> {
    const open = this.#open;
    return new StreamClass<readonly [T, number], E>(async function* () {
      let index = offset;
      for await (const element of open()) {
        if (isFailure(element)) yield element as never;
        else yield [element as T, index++] as const;
      }
    });
  }

  /**
   * Emits `separator` between every two elements — positional, so it also separates a value
   * from a passing failure.
   *
   * ```ts
   * await Stream.from([1, 2, 3]).intersperse(0).collect(); // [1, 0, 2, 0, 3]
   * ```
   */
  intersperse<S>(separator: S): StreamClass<T | S, E> {
    const open = this.#open;
    return new StreamClass<T | S, E>(async function* () {
      let first = true;
      for await (const element of open()) {
        if (!first) yield separator;
        first = false;
        yield element;
      }
    });
  }

  /**
   * Drops *consecutive* duplicate values by key — failures are transparent: they pass
   * through without resetting the last-seen memory.
   *
   * ```ts
   * await Stream.from([1, 1, 2, 2, 1]).dedupBy((n) => n).collect(); // [1, 2, 1]
   * ```
   */
  dedupBy(key: (value: T) => unknown): StreamClass<T, E> {
    const open = this.#open;
    return new StreamClass<T, E>(async function* () {
      let last: unknown = Symbol();
      for await (const element of open()) {
        if (isFailure(element)) yield element;
        else {
          const seen = key(element as T);
          if (seen !== last) yield element;
          last = seen;
        }
      }
    });
  }

  /**
   * Drops consecutive duplicate values — `dedupBy` with identity.
   *
   * ```ts
   * await Stream.from([1, 1, 2, 1]).dedup().collect(); // [1, 2, 1]
   * ```
   */
  dedup(): StreamClass<T, E> {
    return this.dedupBy((value) => value);
  }

  /**
   * Keeps the first occurrence of each value by key, stream-wide (holds a Set of seen keys —
   * bound infinite streams). Failures pass through.
   *
   * ```ts
   * await Stream.from([1, 2, 1, 3, 2]).uniqBy((n) => n).collect(); // [1, 2, 3]
   * ```
   */
  uniqBy(key: (value: T) => unknown): StreamClass<T, E> {
    const open = this.#open;
    return new StreamClass<T, E>(async function* () {
      const seen = new Set<unknown>();
      for await (const element of open()) {
        if (isFailure(element)) yield element;
        else {
          const k = key(element as T);
          if (!seen.has(k)) {
            seen.add(k);
            yield element;
          }
        }
      }
    });
  }

  /**
   * Keeps the first occurrence of each value — `uniqBy` with identity.
   *
   * ```ts
   * await Stream.from([1, 2, 1, 2, 3]).uniq().collect(); // [1, 2, 3]
   * ```
   */
  uniq(): StreamClass<T, E> {
    return this.uniqBy((value) => value);
  }

  /**
   * Emits the running fold of the values — Elixir's `Stream.scan`; without `initial` the
   * first value seeds the accumulator. Failures pass through and leave the accumulator
   * untouched.
   *
   * ```ts
   * await Stream.from([1, 2, 3]).scan((acc, n) => acc + n).collect(); // [1, 3, 6]
   * ```
   */
  scan(fn: (accumulator: T, value: T) => T | PromiseLike<T>): StreamClass<T, E>;
  scan<A>(fn: (accumulator: A, value: T) => A | PromiseLike<A>, initial: A): StreamClass<A, E>;
  scan<A>(
    fn: (accumulator: A, value: T) => A | PromiseLike<A>,
    ...initial: A[]
  ): StreamClass<A, E> {
    const open = this.#open;
    return new StreamClass<A, E>(async function* () {
      let hasAccumulator = initial.length > 0;
      let accumulator = initial[0];
      for await (const element of open()) {
        if (isFailure(element)) yield element as never;
        else {
          // Unseeded, the first value seeds the fold — overload 1 pins A = T there.
          accumulator = hasAccumulator ? await fn(accumulator, element as T) : (element as never);
          hasAccumulator = true;
          yield accumulator;
        }
      }
    });
  }

  /**
   * Runs `fn` per value as a lazy side effect and passes everything through unchanged —
   * Elixir's *lazy* `Stream.each/2`, under the idiomatic JS name. Nothing runs until a
   * consumer pulls; pair with {@link StreamClass#run} for side effects alone.
   *
   * ```ts
   * const seen: number[] = [];
   * await Stream.from([1, 2]).tap((n) => void seen.push(n)).collect(); // [1, 2]
   * seen; // [1, 2]
   * ```
   */
  tap(fn: (value: T, index: number) => void | PromiseLike<void>): StreamClass<T, E> {
    const open = this.#open;
    return new StreamClass<T, E>(async function* () {
      let index = 0;
      for await (const element of open()) {
        if (!isFailure(element)) await fn(element as T, index++);
        yield element;
      }
    });
  }

  /**
   * Tees every value into a web `WritableStream` while passing all elements through —
   * Elixir's `Stream.into/2`, with the platform's own sink as the Collectable. The sink is
   * closed on normal completion and released on early exit; failures pass the tee but are
   * **not** written (the sink types `T`, not `T | E`).
   *
   * ```ts
   * const written: number[] = [];
   * const sink = new WritableStream<number>({ write: (n) => void written.push(n) });
   * await Stream.from([1, 2, 3]).into(sink).collect(); // [1, 2, 3]
   * written; // [1, 2, 3]
   * ```
   */
  into(sink: WritableStream<T>): StreamClass<T, E> {
    const open = this.#open;
    return new StreamClass<T, E>(async function* () {
      const writer = sink.getWriter();
      try {
        for await (const element of open()) {
          if (!isFailure(element)) await writer.write(element as T);
          yield element;
        }
        await writer.close();
      } finally {
        writer.releaseLock();
      }
    });
  }

  /**
   * Groups values into arrays of `count`, sliding by `step` (Elixir's full
   * `chunk_every/4`): `step < count` overlaps windows, `step > count` skips between them.
   * `leftover` rules the trailing partial chunk: emitted as-is by default, `'discard'`
   * drops it, an array pads it up to `count`. Failures pass through **between** chunks
   * without breaking the one being assembled — a bad row never voids the batch around it.
   *
   * ```ts
   * await Stream.from([1, 2, 3, 4, 5]).chunkEvery(2).collect(); // [[1, 2], [3, 4], [5]]
   * await Stream.from([1, 2, 3, 4, 5]).chunkEvery(3, 2, 'discard').collect(); // [[1, 2, 3], [3, 4, 5]]
   * await Stream.from([1, 2, 3, 4]).chunkEvery(3, 3, [0, 0]).collect(); // [[1, 2, 3], [4, 0, 0]]
   * ```
   */
  chunkEvery(count: number, step = count, leftover: T[] | 'discard' = []): StreamClass<T[], E> {
    const open = this.#open;
    return new StreamClass<T[], E>(async function* () {
      let window: T[] = [];
      let skip = 0;
      for await (const element of open()) {
        if (isFailure(element)) yield element as never;
        else if (skip > 0) skip--;
        else {
          window.push(element as T);
          if (window.length === count) {
            yield [...window];
            if (step >= count) {
              window = [];
              skip = step - count;
            } else window = window.slice(step);
          }
        }
      }
      // The trailing partial: only a window that never filled (or the overlap remainder
      // shorter than a full chunk) reaches here.
      if (window.length > 0 && window.length < count) {
        if (leftover === 'discard') return;
        const padded = [...window, ...leftover].slice(0, count);
        yield padded;
      }
    });
  }

  /**
   * Chunks *consecutive* values sharing a key — Elixir's `chunk_by/2`; a key change closes
   * the chunk. Failures are transparent: they pass through without closing the chunk
   * around them, consistent with `dedup`.
   *
   * ```ts
   * await Stream.from([1, 3, 2, 4, 5]).chunkBy((n) => n % 2).collect(); // [[1, 3], [2, 4], [5]]
   * ```
   */
  chunkBy(key: (value: T) => unknown): StreamClass<T[], E> {
    const open = this.#open;
    return new StreamClass<T[], E>(async function* () {
      let chunk: T[] = [];
      let current: unknown = Symbol();
      for await (const element of open()) {
        if (isFailure(element)) yield element as never;
        else {
          const k = key(element as T);
          if (chunk.length > 0 && k !== current) {
            yield chunk;
            chunk = [];
          }
          chunk.push(element as T);
          current = k;
        }
      }
      if (chunk.length > 0) yield chunk;
    });
  }

  /**
   * The general chunker — Elixir's `chunk_while/4`, object-shaped for JS: `step` returns
   * `{ acc }` to keep accumulating, `{ acc, emit }` to emit a chunk, plus `halt: true` to
   * end the stream; `flush` may emit one last chunk from the final accumulator. Values
   * only; failures pass through.
   *
   * ```ts
   * const batchesOfTwo = Stream.from([1, 2, 3, 4, 5]).chunkWhile(
   *   [] as number[],
   *   (n, acc) => (acc.length === 1 ? { acc: [], emit: [...acc, n] } : { acc: [...acc, n] }),
   *   (acc) => (acc.length > 0 ? acc : undefined),
   * );
   * await batchesOfTwo.collect(); // [[1, 2], [3, 4], [5]]
   * ```
   */
  chunkWhile<A, C>(
    initial: A,
    step: (value: T, accumulator: A) => { acc: A; emit?: C; halt?: boolean },
    flush?: (accumulator: A) => C | undefined,
  ): StreamClass<C, E> {
    const open = this.#open;
    return new StreamClass<C, E>(async function* () {
      let accumulator = initial;
      for await (const element of open()) {
        if (isFailure(element)) yield element as never;
        else {
          const result = step(element as T, accumulator);
          accumulator = result.acc;
          if (result.emit !== undefined) yield result.emit;
          if (result.halt) break;
        }
      }
      const last = flush?.(accumulator);
      if (last !== undefined) yield last;
    });
  }

  /**
   * The general engine — Elixir's `Stream.transform`, JS-shaped: hand the raw element flow
   * to your own async generator and yield whatever you want. The one transform where
   * failures do **not** auto-pass: your generator sees them and owns the ruling. Every
   * missing combinator is three lines away through this.
   *
   * ```ts
   * const pairs = Stream.from([1, 2, 3, 4]).through(async function* (elements) {
   *   let previous: number | undefined;
   *   for await (const n of elements) {
   *     if (previous !== undefined) yield [previous, n] as const;
   *     previous = n;
   *   }
   * });
   * await pairs.collect(); // [[1, 2], [2, 3], [3, 4]]
   * ```
   */
  through<U>(
    fn: (elements: AsyncIterable<T | E>) => Source<U>,
  ): StreamClass<Exclude<U, AnyFailure>, Extract<U, AnyFailure>> {
    const open = this.#open;
    return new StreamClass(() => iterate(fn(open()))) as never;
  }

  // ── Consumers — each returns a Task, completing the shared vocabulary ────────

  /**
   * Collects every value, **fail-fast**: the first failure element rejects the Task with it
   * (declared — so `.result()` reflects it bare and typed). The `Result.all` of streams.
   *
   * NOT `values()`: in JS `.values()` *produces* an iterator (`Array`, `Map`, `Set`,
   * `ReadableStream`) rather than consuming one, and `partition().values` filters failures out
   * while this throws on them — the same word for opposite behaviour inside one module.
   *
   * NOT `all()` either, tempting as the `Result.all` mirror was: every other language in this
   * module's lineage spends "all" on the **predicate** — Rust's `StreamExt::all(pred)`, Elixir's
   * `Enum.all?/2` — which is {@link StreamClass#every} here. `collect` is Rust's word for
   * gathering and collides with nothing.
   *
   * Rust gets one `collect` for both this and {@link StreamClass#results} because the target
   * type picks the behaviour; JS cannot dispatch on return type, so the two need two names.
   *
   * ```ts
   * await Stream.from(['a', 'b']).collect(); // ['a', 'b']
   * ```
   */
  collect(): Task<T[], E> {
    const open = this.#open;
    return Task(async () => {
      const collected: T[] = [];
      for await (const element of open()) {
        if (isFailure(element)) throw element;
        collected.push(element as T);
      }
      return collected;
    });
  }

  /**
   * Collects every element, positionally, failures included — the `Task.results` of streams.
   * Each failure is reported to the observation seam as it is classified into the value
   * world, so tracing sees per-element failures a consumer chose to keep.
   *
   * ```ts
   * import * as Failure from '../result/failure.ts';
   *
   * const Odd = Failure.define('Odd', (d: { n: number }) => `${d.n} is odd`);
   * const outcomes = await Stream.from([2, Odd({ n: 3 }), 4]).results();
   * outcomes.length; // 3 — nothing lost, order kept
   * ```
   */
  results(): Task<Result<T, E>[], never> {
    const open = this.#open;
    return Task(async () => {
      const collected: Result<T, E>[] = [];
      for await (const element of open()) {
        if (isFailure(element)) observed(element);
        collected.push(element as Result<T, E>);
      }
      return collected;
    });
  }

  /**
   * Splits the stream into `{ values, errors }`, keeping both — `Result.partition`, fed by
   * the stream. Literally `results()` piped through `partition`: the three modules share one
   * vocabulary, so the composition is one line.
   *
   * ```ts
   * import * as Failure from '../result/failure.ts';
   *
   * const Bad = Failure.define('Bad', 'bad element');
   * const { values, errors } = await Stream.from([1, Bad(), 2]).partition();
   * values; // [1, 2]
   * errors.length; // 1
   * ```
   */
  partition(): Task<{ values: T[]; errors: E[] }, never> {
    return this.results().map((outcomes) => partition(outcomes)) as Task<
      { values: T[]; errors: E[] },
      never
    >;
  }

  /**
   * Folds every value into one, **fail-fast** like {@link StreamClass#collect} — the terminal
   * counterpart to {@link StreamClass#scan}'s lazy running fold, and the reason a ten-million-row
   * stream can answer with a single number.
   *
   * Without it the only route is `(await stream.collect()).reduce(…)`, which buffers the whole
   * source to produce one value and gives back everything the module exists to avoid. Elixir does
   * not need a member here because `Enum.reduce` accepts any Enumerable; JS has no such fallback.
   *
   * `initial` is required. The seedless form would have to raise on an empty stream — the way
   * `[].reduce(fn)` does — and a stream's emptiness is not knowable before it is drained, so the
   * failure would arrive at the worst possible moment. Naming the seed also names `A`.
   *
   * ```ts
   * const total = await Stream.from([1, 2, 3]).reduce((sum, n) => sum + n, 0);
   * total; // 6
   * ```
   */
  reduce<A>(
    fn: (accumulator: A, value: T, index: number) => A | PromiseLike<A>,
    initial: A,
  ): Task<A, E> {
    const open = this.#open;

    return Task(async () => {
      let accumulator = initial;
      let index = 0;
      for await (const element of open()) {
        if (isFailure(element)) throw element;
        accumulator = await fn(accumulator, element as T, index++);
      }

      return accumulator;
    });
  }

  /**
   * Whether **any** value satisfies `predicate` — short-circuiting: the source is not pulled past
   * the first match. JS's name for Elixir's `Enum.any?/2` and Rust's `StreamExt::any`.
   *
   * Fail-fast like the other terminals: a failure element rejects, because a stream that could
   * not produce one of its values cannot honestly answer a question about all of them.
   *
   * ```ts
   * await Stream.from([1, 2, 3]).some((n) => n > 2); // true
   * ```
   */
  some(predicate: (value: T, index: number) => boolean | PromiseLike<boolean>): Task<boolean, E> {
    const open = this.#open;

    return Task(async () => {
      let index = 0;
      for await (const element of open()) {
        if (isFailure(element)) throw element;
        if (await predicate(element as T, index++)) return true;
      }

      return false;
    });
  }

  /**
   * Whether **every** value satisfies `predicate` — short-circuiting on the first that does not.
   *
   * This is the member Rust and Elixir both call `all`; JS calls it `every`, and JS wins here for
   * the same reason `forEach` did. {@link StreamClass#collect} is the collector, and the two are
   * told apart by their arguments as much as their names: `every` takes a predicate, `collect`
   * takes nothing.
   *
   * Vacuously `true` on an empty stream, matching `Array.prototype.every`.
   *
   * ```ts
   * await Stream.from([2, 4]).every((n) => n % 2 === 0); // true
   * ```
   */
  every(predicate: (value: T, index: number) => boolean | PromiseLike<boolean>): Task<boolean, E> {
    const open = this.#open;

    return Task(async () => {
      let index = 0;
      for await (const element of open()) {
        if (isFailure(element)) throw element;
        if (!(await predicate(element as T, index++))) return false;
      }

      return true;
    });
  }

  /**
   * The first value satisfying `predicate`, or `undefined` — short-circuiting, so an infinite
   * source is fine as long as a match exists.
   *
   * `undefined` rather than a Failure for "not found": absence is an ordinary answer to a search,
   * not a failure of the run, and `Array.prototype.find` sets the expectation.
   *
   * ```ts
   * await Stream.from([1, 2, 3]).find((n) => n > 1); // 2
   * ```
   */
  find(
    predicate: (value: T, index: number) => boolean | PromiseLike<boolean>,
  ): Task<T | undefined, E> {
    const open = this.#open;

    return Task(async () => {
      let index = 0;
      for await (const element of open()) {
        if (isFailure(element)) throw element;
        if (await predicate(element as T, index++)) return element as T;
      }

      return undefined;
    });
  }

  /**
   * Drains the stream, running `fn` per value — **fail-fast** like {@link StreamClass#collect}.
   * The Task resolves when the source ends; use it when the work is the side effect.
   *
   * Elixir's `Stream.each/2` is the lazy tap, which lives here as {@link StreamClass#tap} because
   * that is the name JS gave it. This is the terminal drain, and it takes JS's name for that:
   * every iterable in the language spells it `forEach` — Array, Map, Set, and
   * `Iterator.prototype` since ES2025 — as do Rust's `StreamExt::for_each` and TC39's pending
   * async iterator helpers. `Array.prototype.each` has never existed.
   *
   * Sequential, for the same reason {@link StreamClass#map} is: the next element is not pulled
   * until `fn` has settled. That is what makes it safe to write to a database from here, and
   * what makes it the wrong place to fan out — {@link StreamClass.asyncStream} is.
   *
   * ```ts
   * const seen: number[] = [];
   * await Stream.from([1, 2, 3]).forEach((n) => void seen.push(n));
   * seen; // [1, 2, 3]
   * ```
   */
  forEach(fn: (value: T, index: number) => void | PromiseLike<void>): Task<void, E> {
    const open = this.#open;
    return Task(async () => {
      let index = 0;
      for await (const element of open()) {
        if (isFailure(element)) throw element;
        await fn(element as T, index++);
      }
    });
  }

  /**
   * Forces the stream for its side effects alone — Elixir's `Stream.run/1`. Fail-fast like
   * {@link StreamClass#forEach}: pair with {@link StreamClass#tap} for the effects.
   *
   * ```ts
   * const seen: number[] = [];
   * await Stream.from([1, 2]).tap((n) => void seen.push(n)).run();
   * seen; // [1, 2]
   * ```
   */
  run(): Task<void, E> {
    return this.forEach(() => {});
  }

  /**
   * Streams are `for await`-able; elements arrive bare (`T | E`), so a hand-rolled loop
   * discriminates with `Failure.is` exactly like any other union consumer.
   *
   * ```ts
   * const seen: number[] = [];
   * for await (const element of Stream.from([1, 2])) seen.push(element);
   * seen; // [1, 2]
   * ```
   */
  [Symbol.asyncIterator](): AsyncIterator<T | E> {
    return this.#open();
  }
}

// The class is `StreamClass` for the same reason Task's is `TaskClass`: one identifier
// cannot be both the class binding and the exported type name below.
Object.defineProperty(StreamClass, 'name', { value: 'Stream' });

/**
 * The exported value: builders (`Stream.from`, `Stream.unfold`, `Stream.lines`) are the only
 * entry points — there is no public constructor and no call form.
 *
 * ```ts
 * const stream = Stream.from([1, 2, 3]);
 * await stream.map((n) => n + 1).collect(); // [2, 3, 4]
 * ```
 */
export const Stream = StreamClass;

/**
 * The type spelling: a signature says `Stream<Row, BadRow>` while the same identifier
 * builds one — the Task naming pattern, applied to the third shape.
 *
 * ```ts
 * const rows = (): Stream<number> => Stream.from([1, 2, 3]);
 * await rows().collect(); // [1, 2, 3]
 * ```
 */
export type Stream<T, E = never> = StreamClass<T, E>;
