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
import { isFailure, observed, type Any as AnyFailure } from '../result/failure.ts';
import { Task } from '../task/task.ts';
import { partition, type Result } from '../result/result.ts';

/** Anything a Stream can be built from or flattened into: sync or async iterables (a web `ReadableStream` is async-iterable on every modern runtime). */
export type Source<T> = AsyncIterable<T> | Iterable<T>;

async function* iterate<T>(source: Source<T>): AsyncGenerator<T> {
  yield* source as AsyncIterable<T>;
}

/**
 * The stream pipeline: build with a static (`from`/`unfold`/`lines`), shape with lazy
 * transforms (`map`/`filter`/`flatMap`/`take`), finish with a Task-returning consumer
 * (`values`/`results`/`partition`/`each`) — or `for await` the bare elements directly.
 *
 * ```ts
 * const evens = Stream.from([1, 2, 3, 4]).filter((n) => n % 2 === 0);
 * await evens.map((n) => n * 10).values(); // [20, 40]
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
   * const doubled = await Stream.from([1, 2, 3]).map((n) => n * 2).values();
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
   * await countdown.values(); // [3, 2, 1]
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
   * await Stream.lines(bytes).values(); // ['a', 'bc', 'd']
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
   * await Stream.concat([1, 2], [3]).values(); // [1, 2, 3]
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
   * await Stream.cycle([1, 2]).take(5).values(); // [1, 2, 1, 2, 1]
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
   * await Stream.iterate(1, (n) => n * 2).take(4).values(); // [1, 2, 4, 8]
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
   * await Stream.repeatedly(() => ++n).take(3).values(); // [1, 2, 3]
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
   * await Stream.duplicate('x', 3).values(); // ['x', 'x', 'x']
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
   * await Stream.fromIndex(10).take(3).values(); // [10, 11, 12]
   * ```
   */
  static fromIndex(offset = 0): StreamClass<number> {
    return new StreamClass<number, never>(async function* () {
      for (let n = offset; ; n++) yield n;
    });
  }

  // ── Transforms — lazy, failures pass through untouched ──────────────────────

  /**
   * Transforms each **value**; failure elements flow past untouched (the railway, per
   * element). `fn` may itself return a Failure — that widens the stream's `E`, which is how
   * a parse step turns raw input into `Row | BadRow` without a wrapper per element. A throw
   * inside `fn` is a bug and rejects the consumer.
   *
   * ```ts
   * const tagged = await Stream.from([1, 2]).map((n, i) => `${i}:${n}`).values();
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
   * await Stream.from([1, 2, 3, 4]).filter((n) => n % 2 === 0).values(); // [2, 4]
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
   * await Stream.from([[1, 2], [3]]).flatMap((page) => page).values(); // [1, 2, 3]
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
   * await firstTwo.values(); // [0, 1] — and pulled is 2, not ∞
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
   * await Stream.from([1, 2, 3, 4]).reject((n) => n % 2 === 0).values(); // [1, 3]
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
   * await Stream.from([1, 2, 9, 1]).takeWhile((n) => n < 5).values(); // [1, 2]
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
   * await Stream.from([1, 2, 3, 4]).drop(2).values(); // [3, 4]
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
   * await Stream.from([1, 2, 9, 1]).dropWhile((n) => n < 5).values(); // [9, 1]
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
   * await Stream.from([0, 1, 2, 3, 4]).takeEvery(2).values(); // [0, 2, 4]
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
   * await Stream.from([0, 1, 2, 3, 4]).dropEvery(2).values(); // [1, 3]
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
   * await Stream.from([1, 1, 1, 1]).mapEvery(2, (n) => n * 10).values(); // [10, 1, 10, 1]
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
   * await Stream.from(['a', 'b']).withIndex(1).values(); // [['a', 1], ['b', 2]]
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
   * await Stream.from([1, 2, 3]).intersperse(0).values(); // [1, 0, 2, 0, 3]
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
   * await Stream.from([1, 1, 2, 2, 1]).dedupBy((n) => n).values(); // [1, 2, 1]
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
   * await Stream.from([1, 1, 2, 1]).dedup().values(); // [1, 2, 1]
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
   * await Stream.from([1, 2, 1, 3, 2]).uniqBy((n) => n).values(); // [1, 2, 3]
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
   * await Stream.from([1, 2, 1, 2, 3]).uniq().values(); // [1, 2, 3]
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
   * await Stream.from([1, 2, 3]).scan((acc, n) => acc + n).values(); // [1, 3, 6]
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
   * Groups values into arrays of `count` (a trailing partial chunk is emitted). Failures
   * pass through **between** chunks without breaking the one being assembled — a bad row
   * never voids the batch around it.
   *
   * ```ts
   * await Stream.from([1, 2, 3, 4, 5]).chunkEvery(2).values(); // [[1, 2], [3, 4], [5]]
   * ```
   */
  chunkEvery(count: number): StreamClass<T[], E> {
    const open = this.#open;
    return new StreamClass<T[], E>(async function* () {
      let chunk: T[] = [];
      for await (const element of open()) {
        if (isFailure(element)) yield element as never;
        else {
          chunk.push(element as T);
          if (chunk.length >= count) {
            yield chunk;
            chunk = [];
          }
        }
      }
      if (chunk.length > 0) yield chunk;
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
   * await pairs.values(); // [[1, 2], [2, 3], [3, 4]]
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
   * ```ts
   * await Stream.from(['a', 'b']).values(); // ['a', 'b']
   * ```
   */
  values(): Task<T[], E> {
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
   * Drains the stream, running `fn` per value — **fail-fast** like {@link StreamClass#values}.
   * The Task resolves when the source ends; use it when the work is the side effect.
   *
   * ```ts
   * const seen: number[] = [];
   * await Stream.from([1, 2, 3]).each((n) => void seen.push(n));
   * seen; // [1, 2, 3]
   * ```
   */
  each(fn: (value: T, index: number) => void | PromiseLike<void>): Task<void, E> {
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
 * await stream.map((n) => n + 1).values(); // [2, 3, 4]
 * ```
 */
export const Stream = StreamClass;

/**
 * The type spelling: a signature says `Stream<Row, BadRow>` while the same identifier
 * builds one — the Task naming pattern, applied to the third shape.
 *
 * ```ts
 * const rows = (): Stream<number> => Stream.from([1, 2, 3]);
 * await rows().values(); // [1, 2, 3]
 * ```
 */
export type Stream<T, E = never> = StreamClass<T, E>;
