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
