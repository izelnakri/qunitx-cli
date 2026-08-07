import { module, test } from 'qunitx';
import { Stream, Failure } from '../../lib/stream/index.ts';

const BadRow = Failure.define('BadRow', (d: { line: number }) => `bad row ${d.line}`);

// ── Laziness and sources ──────────────────────────────────────────────────────

module('Stream | lazy', { concurrency: true }, () => {
  test('nothing is pulled until a consumer iterates', async (assert) => {
    let pulled = 0;
    const stream = Stream.from(
      (function* () {
        for (;;) yield ++pulled;
      })(),
    ).map((n) => n * 10);
    assert.strictEqual(pulled, 0, 'building a pipeline pulls nothing');
    assert.deepEqual(await stream.take(2).collect(), [10, 20]);
    assert.strictEqual(pulled, 2, 'only the taken elements were pulled — backpressure');
  });

  test('every rung of the ladder is inert except the last', async (assert) => {
    // Two lazy gates sit between a pipeline and its work, and `await` only opens the second.
    // Pinned rung by rung because the middle two are the surprising ones: `await stream` looks
    // like it should run something and does not, since a Stream is AsyncIterable and NOT a
    // thenable — `await` on a non-thenable hands the object straight back.
    let pulled = 0;
    const stream = Stream.from(
      (function* () {
        for (;;) yield ++pulled;
      })(),
    ).map((n) => n * 10);

    const taken = stream.take(2);
    assert.strictEqual(pulled, 0, 'a transform returns a Stream and runs nothing');

    const awaited = await taken;
    assert.strictEqual(pulled, 0, 'awaiting a STREAM runs nothing either');
    assert.strictEqual(awaited, taken, 'it resolves to the very same Stream object');

    const task = taken.collect();
    assert.strictEqual(pulled, 0, 'a terminal returns a Task — still nothing has run');

    assert.deepEqual(await task, [10, 20], 'awaiting the TASK is what runs it');
    assert.strictEqual(pulled, 2);
  });

  test('a Stream from a re-iterable source is re-consumable', async (assert) => {
    const stream = Stream.from([1, 2]);
    assert.deepEqual(await stream.collect(), [1, 2]);
    assert.deepEqual(await stream.collect(), [1, 2], 'arrays re-open per consumer');
  });

  test('unfold grows lazily from a seed and stops on null', async (assert) => {
    let fetches = 0;
    const pages = Stream.unfold(1, (page) => {
      fetches += 1;
      return page > 3 ? null : ([`page-${page}`, page + 1] as const);
    });
    assert.deepEqual(await pages.collect(), ['page-1', 'page-2', 'page-3']);
    assert.deepEqual(await pages.take(1).collect(), ['page-1']);
    assert.strictEqual(fetches, 5, 'take(1) fetched one page, not all');
  });

  test('lines splits across chunk boundaries and flushes the tail', async (assert) => {
    const encode = (s: string) => new TextEncoder().encode(s);
    const chunks = [encode('alpha\nbe'), encode('ta\nga'), encode('mma')];
    assert.deepEqual(await Stream.lines(chunks).collect(), ['alpha', 'beta', 'gamma']);
  });
});

// ── The per-element railway ───────────────────────────────────────────────────

module('Stream | railway', { concurrency: true }, () => {
  const mixed = () =>
    Stream.from(['1', 'x', '3']).map((raw, n) => {
      const parsed = Number(raw);
      return Number.isNaN(parsed) ? BadRow({ line: n + 1 }) : parsed;
    });

  test('map widens E when fn returns a Failure, and later maps skip failures', async (assert) => {
    const doubled = mixed().map((n) => n * 2); // BadRow must flow PAST this untouched
    const { values, errors } = await doubled.partition();
    assert.deepEqual(values, [2, 6]);
    assert.deepEqual(
      errors.map((e) => e.data.line),
      [2],
    );
  });

  test('filter never drops failures — only values are filtered', async (assert) => {
    const { errors } = await mixed()
      .filter(() => false)
      .partition();
    assert.strictEqual(errors.length, 1, 'the failure survived a reject-everything filter');
  });

  test('flatMap expands values and passes failures through unexpanded', async (assert) => {
    const { values, errors } = await mixed()
      .flatMap((n) => [n, n])
      .partition();
    assert.deepEqual(values, [1, 1, 3, 3]);
    assert.strictEqual(errors.length, 1);
  });

  test('a bug thrown inside map rejects the consumer — never boxed into the flow', async (assert) => {
    const buggy = Stream.from([1]).map(() => {
      throw new TypeError('boom');
    });
    await assert.rejects(buggy.collect(), TypeError);
    await assert.rejects(buggy.results(), TypeError, 'even the keep-everything consumer');
  });
});

// ── Consumers ─────────────────────────────────────────────────────────────────

module('Stream | consumers', { concurrency: true }, () => {
  const withFailure = () => Stream.from([1, BadRow({ line: 9 }), 3]);

  test('collect() fail-fasts on the first failure element, as a declared rejection', async (assert) => {
    const outcome = await withFailure().collect().result(); // number[] | BadRow — bare
    assert.true(BadRow.is(outcome));
    assert.strictEqual((outcome as Failure.Of<typeof BadRow>).data.line, 9);
  });

  test('results() keeps everything positionally, failures included', async (assert) => {
    const outcomes = await withFailure().results();
    assert.strictEqual(outcomes.length, 3);
    assert.true(Failure.is(outcomes[1]));
  });

  test('forEach() drains with side effects, and fail-fasts the way collect does', async (assert) => {
    const seen: number[] = [];
    await Stream.from([1, 2]).forEach((n) => void seen.push(n));
    assert.deepEqual(seen, [1, 2]);
    await assert.rejects(
      withFailure().forEach(() => {}),
      /bad row 9/,
    );
  });

  test('for await yields bare elements, discriminated by Failure.is', async (assert) => {
    const codes: string[] = [];
    for await (const element of withFailure()) {
      if (Failure.is(element)) codes.push(element.code);
    }
    assert.deepEqual(codes, ['BadRow']);
  });

  test('take counts every element, values and failures alike', async (assert) => {
    const { values, errors } = await withFailure().take(2).partition();
    assert.deepEqual(values, [1]);
    assert.strictEqual(errors.length, 1, 'the cut lands after the failure, not around it');
  });
});

// Serial on purpose: onObserved is a process-wide single slot, and concurrent siblings that
// consume failures (collect().result(), partition()) would report into this test's collector.
module('Stream | observation seam', () => {
  test('results() reports each kept failure to Failure.onObserved exactly once', async (assert) => {
    const seen: string[] = [];
    Failure.onObserved((failure) => seen.push(failure.code));
    try {
      const outcomes = await Stream.from([1, BadRow({ line: 9 }), 3]).results();
      assert.strictEqual(outcomes.length, 3);
      assert.deepEqual(seen, ['BadRow'], 'the kept failure was observed exactly once');
    } finally {
      Failure.onObserved(null);
    }
  });
});

// ── Tier-1 sweep: builders ────────────────────────────────────────────────────

module('Stream | builders', { concurrency: true }, () => {
  test('concat, duplicate and fromIndex compose in order', async (assert) => {
    assert.deepEqual(await Stream.concat([1], [2, 3]).collect(), [1, 2, 3]);
    assert.deepEqual(await Stream.duplicate('x', 2).collect(), ['x', 'x']);
    assert.deepEqual(await Stream.fromIndex(5).take(2).collect(), [5, 6]);
  });

  test('cycle, iterate and repeatedly are infinite until bounded', async (assert) => {
    assert.deepEqual(await Stream.cycle([1, 2]).take(5).collect(), [1, 2, 1, 2, 1]);
    assert.deepEqual(
      await Stream.iterate(1, (n) => n * 3)
        .take(3)
        .collect(),
      [1, 3, 9],
    );
    let calls = 0;
    assert.deepEqual(
      await Stream.repeatedly(() => ++calls)
        .take(2)
        .collect(),
      [1, 2],
    );
    assert.deepEqual(await Stream.cycle([]).collect(), [], 'an empty cycle ends, never spins');
  });
});

// ── Tier-1 sweep: the positional/value rule per transform ────────────────────

module('Stream | tier-1 transforms', { concurrency: true }, () => {
  const withFailure = () => Stream.from([1, BadRow({ line: 1 }), 2, 3]);

  test('drop is positional — values and failures both count, like take', async (assert) => {
    const { values, errors } = await withFailure().drop(2).partition();
    assert.deepEqual(values, [2, 3]);
    assert.strictEqual(errors.length, 0, 'the dropped prefix included the failure — explicit');
  });

  test('takeWhile ends at the first refused value; failures pass untested', async (assert) => {
    const { values, errors } = await withFailure()
      .takeWhile((n) => n < 2)
      .partition();
    assert.deepEqual(values, [1]);
    assert.strictEqual(errors.length, 1, 'the failure inside the window passed through');
  });

  test('dropWhile emits failures even during the dropping phase', async (assert) => {
    const { values, errors } = await withFailure()
      .dropWhile((n) => n < 3)
      .partition();
    assert.deepEqual(values, [3]);
    assert.strictEqual(errors.length, 1, 'a value predicate never swallows a failure');
  });

  test('takeEvery/dropEvery/mapEvery count values only', async (assert) => {
    assert.deepEqual(await Stream.from([0, 1, 2, 3, 4]).takeEvery(2).collect(), [0, 2, 4]);
    assert.deepEqual(await Stream.from([0, 1, 2, 3, 4]).dropEvery(2).collect(), [1, 3]);
    const everied = await withFailure()
      .mapEvery(2, (n) => n * 10)
      .partition();
    assert.deepEqual(everied.values, [10, 2, 30], 'failure did not advance the value counter');
  });

  test('reject, intersperse and withIndex', async (assert) => {
    assert.deepEqual(
      await Stream.from([1, 2, 3])
        .reject((n) => n === 2)
        .collect(),
      [1, 3],
    );
    assert.deepEqual(await Stream.from([1, 2]).intersperse(0).collect(), [1, 0, 2]);
    const indexed = await withFailure().withIndex().partition();
    assert.deepEqual(
      indexed.values,
      [
        [1, 0],
        [2, 1],
        [3, 2],
      ],
      'failures consume no index',
    );
  });

  test('dedup is failure-transparent; uniq is stream-wide', async (assert) => {
    const deduped = await Stream.from([1, BadRow({ line: 2 }), 1, 2])
      .dedup()
      .partition();
    assert.deepEqual(deduped.values, [1, 2], 'equal values around a failure stay consecutive');
    assert.strictEqual(deduped.errors.length, 1);
    assert.deepEqual(await Stream.from([1, 2, 1, 3]).uniq().collect(), [1, 2, 3]);
  });

  test('scan folds values, seeded or seeded-by-first, and passes failures', async (assert) => {
    assert.deepEqual(
      await Stream.from([1, 2, 3])
        .scan((a, n) => a + n)
        .collect(),
      [1, 3, 6],
    );
    const seeded = await withFailure()
      .scan((a, n) => a + n, 10)
      .partition();
    assert.deepEqual(seeded.values, [11, 13, 16], 'the failure left the accumulator untouched');
  });
});

// ── Tier-2: chunkEvery + through ──────────────────────────────────────────────

module('Stream | chunking and the general engine', { concurrency: true }, () => {
  test('chunkEvery emits full chunks, a trailing partial, and never breaks a chunk on a failure', async (assert) => {
    const { values, errors } = await Stream.from([1, BadRow({ line: 7 }), 2, 3])
      .chunkEvery(2)
      .partition();
    assert.deepEqual(values, [[1, 2], [3]], 'the failure passed BETWEEN chunks, batch intact');
    assert.strictEqual(errors.length, 1);
  });

  test('through hands the raw flow over — failures included, the ruling is yours', async (assert) => {
    const codes: string[] = [];
    const cleaned = Stream.from([1, BadRow({ line: 3 }), 2]).through(async function* (elements) {
      for await (const element of elements) {
        if (Failure.is(element))
          codes.push(element.code); // absorbed by THIS generator
        else yield element * 10;
      }
    });
    assert.deepEqual(await cleaned.collect(), [10, 20]);
    assert.deepEqual(codes, ['BadRow'], 'through saw the failure raw — no auto-pass');
  });
});

// ── Tier-3 pin: early exit runs source cleanup (Elixir resource/3's `after`) ──

module('Stream | cleanup', { concurrency: true }, () => {
  test('breaking early runs the source generator finally block', async (assert) => {
    let cleaned = false;
    const resource = Stream.from(
      (async function* () {
        try {
          for (let n = 0; ; n++) yield n;
        } finally {
          cleaned = true; // resource/3's `after`, natively: for-await break → generator.return()
        }
      })(),
    );
    assert.deepEqual(await resource.take(2).collect(), [0, 1]);
    assert.true(cleaned, 'take() closed the source — no leaked handle');
  });
});

// ── Full parity: zip, timers, resource, tee, chunk family, tap/run ───────────

module('Stream | zip', { concurrency: true }, () => {
  test('zips in lockstep, ends at the shortest, and closes the longer source', async (assert) => {
    let cleaned = false;
    const longer = (async function* () {
      try {
        for (let n = 0; ; n++) yield n;
      } finally {
        cleaned = true;
      }
    })();
    assert.deepEqual(await Stream.zip(['a', 'b'], longer).collect(), [
      ['a', 0],
      ['b', 1],
    ]);
    assert.true(cleaned, 'the infinite side was closed, not leaked');
  });

  test('a failure element passes bare without consuming from the other sources', async (assert) => {
    const { values, errors } = await Stream.zip(
      [1, BadRow({ line: 4 }), 2],
      ['a', 'b'],
    ).partition();
    assert.deepEqual(
      values,
      [
        [1, 'a'],
        [2, 'b'],
      ],
      'pairs stayed aligned around the failure',
    );
    assert.strictEqual(errors.length, 1);
  });

  test('zipWith combines the tuple spread', async (assert) => {
    assert.deepEqual(
      await Stream.zipWith(
        [
          [1, 2],
          [10, 20],
        ],
        (a, b) => a + b,
      ).collect(),
      [11, 22],
    );
  });
});

module('Stream | timers and resource', { concurrency: true }, () => {
  test('interval ticks and timer emits once', async (assert) => {
    assert.deepEqual(await Stream.interval(1).take(3).collect(), [0, 1, 2]);
    assert.deepEqual(await Stream.timer(1).collect(), [0]);
  });

  test('resource runs after() on normal end AND on early exit', async (assert) => {
    const events: string[] = [];
    const make = () =>
      Stream.resource(
        () => (events.push('open'), 0),
        (n) => (n < 3 ? ([n, n + 1] as const) : null),
        () => void events.push('close'),
      );
    assert.deepEqual(await make().collect(), [0, 1, 2]);
    assert.deepEqual(await make().take(1).collect(), [0], 'early exit');
    assert.deepEqual(events, ['open', 'close', 'open', 'close']);
  });
});

module('Stream | tee and chunk family', { concurrency: true }, () => {
  test('into writes values to the sink, passes failures through unwritten', async (assert) => {
    const written: number[] = [];
    const sink = new WritableStream<number>({ write: (n) => void written.push(n) });
    const { values, errors } = await Stream.from([1, BadRow({ line: 2 }), 3])
      .into(sink)
      .partition();
    assert.deepEqual(values, [1, 3]);
    assert.strictEqual(errors.length, 1, 'the failure passed the tee');
    assert.deepEqual(written, [1, 3], 'only values reached the sink');
  });

  test('chunkEvery full arity: sliding windows, skipping steps, leftover rules', async (assert) => {
    const src = () => Stream.from([1, 2, 3, 4, 5]);
    assert.deepEqual(await src().chunkEvery(3, 2).collect(), [[1, 2, 3], [3, 4, 5], [5]]);
    assert.deepEqual(await src().chunkEvery(3, 2, 'discard').collect(), [
      [1, 2, 3],
      [3, 4, 5],
    ]);
    assert.deepEqual(
      await src().chunkEvery(2, 3).collect(),
      [
        [1, 2],
        [4, 5],
      ],
      'step > count skips',
    );
    assert.deepEqual(
      await Stream.from([1, 2, 3, 4]).chunkEvery(3, 3, [0, 0]).collect(),
      [
        [1, 2, 3],
        [4, 0, 0],
      ],
      'pad from the leftover array',
    );
  });

  test('chunkBy closes on key change; failures are transparent to the chunk', async (assert) => {
    const { values, errors } = await Stream.from([1, 3, BadRow({ line: 1 }), 5, 2])
      .chunkBy((n) => n % 2)
      .partition();
    assert.deepEqual(values, [[1, 3, 5], [2]], 'the failure did not close the odd chunk');
    assert.strictEqual(errors.length, 1);
  });

  test('chunkWhile emits on demand, halts on demand, and flushes', async (assert) => {
    const untilNegative = Stream.from([1, 2, -1, 9]).chunkWhile(
      [] as number[],
      (n, acc) => (n < 0 ? { acc, halt: true } : { acc: [...acc, n] }),
      (acc) => (acc.length > 0 ? acc : undefined),
    );
    assert.deepEqual(await untilNegative.collect(), [[1, 2]], 'halted before 9, flushed the acc');
  });
});

module('Stream | tap and run', { concurrency: true }, () => {
  test('tap is lazy and passes everything; run forces for effects alone', async (assert) => {
    const seen: number[] = [];
    const tapped = Stream.from([1, 2]).tap((n) => void seen.push(n));
    assert.deepEqual(seen, [], 'tap ran nothing eagerly');
    await tapped.run();
    assert.deepEqual(seen, [1, 2]);
  });
});

// ── asyncStream — Task.async_stream/3 at its JS home ─────────────────────────

module('Stream | asyncStream', { concurrency: true }, () => {
  test('bounds concurrency and keeps source order by default', async (assert) => {
    let inFlight = 0;
    let peak = 0;
    const out = await Stream.asyncStream(
      [30, 10, 20, 5],
      async (ms) => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, ms));
        inFlight--;
        return ms;
      },
      { maxConcurrency: 2 },
    ).collect();
    assert.deepEqual(out, [30, 10, 20, 5], 'source order, whatever finished first');
    assert.strictEqual(peak, 2, 'never more than maxConcurrency in flight');
  });

  test('ordered: false yields completion order', async (assert) => {
    const out = await Stream.asyncStream(
      [50, 5],
      async (ms) => (await new Promise((r) => setTimeout(r, ms)), ms),
      { maxConcurrency: 2, ordered: false },
    ).collect();
    assert.deepEqual(out, [5, 50], 'the fast element surfaced first');
  });

  test('a per-element deadline becomes a declared AsyncTimeout ELEMENT', async (assert) => {
    const { values, errors } = await Stream.asyncStream(
      [1, 999, 2],
      async (ms) => (await new Promise((r) => setTimeout(r, ms)), ms),
      { maxConcurrency: 3, timeoutMs: 100 },
    ).partition();
    assert.deepEqual(values, [1, 2], 'the survivors landed');
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, 'AsyncTimeout', 'the slow element became data, not a crash');
  });

  test('source failure elements pass through unmapped; a throw stays a bug', async (assert) => {
    const { values, errors } = await Stream.asyncStream(
      [1, BadRow({ line: 3 }), 2],
      (n) => (n as number) * 10,
      { maxConcurrency: 2 },
    ).partition();
    assert.deepEqual(values, [10, 20]);
    assert.strictEqual(errors.length, 1, 'the failure rode the railway past fn');
    await assert.rejects(
      Stream.asyncStream([1], () => {
        throw new TypeError('boom');
      }).collect(),
      TypeError,
    );
  });

  test('lazy: nothing starts until a consumer pulls', async (assert) => {
    let started = 0;
    const stream = Stream.asyncStream([1, 2, 3], (n) => (started++, n));
    assert.strictEqual(started, 0, 'building the pipeline ran nothing');
    await stream.collect();
    assert.strictEqual(started, 3);
  });
});

// ── The push source ───────────────────────────────────────────────────────────

module('Stream | channel', { concurrency: true }, () => {
  test('emits arrive in order', async (assert) => {
    const channel = Stream.channel<number>();
    const collected = channel.stream.collect();
    channel.emit(1);
    channel.emit(2);
    channel.close();
    assert.deepEqual(await collected, [1, 2]);
  });

  test('emits before anyone consumes are buffered, not lost', async (assert) => {
    const channel = Stream.channel<number>();
    channel.emit(1);
    channel.emit(2);
    channel.close();
    assert.strictEqual(channel.buffered, 2, 'held for whoever arrives');
    assert.deepEqual(await channel.stream.collect(), [1, 2], 'and delivered on arrival');
  });

  test('close() ends the stream only after the buffer drains', async (assert) => {
    const channel = Stream.channel<number>();
    channel.emit(1);
    channel.close();
    assert.true(channel.closed);
    assert.deepEqual(
      await channel.stream.collect(),
      [1],
      'closing is not a discard — what was emitted still arrives',
    );
  });

  test('close() is idempotent and wakes a parked consumer', async (assert) => {
    const channel = Stream.channel<number>();
    const collected = channel.stream.collect();
    await Promise.resolve();
    channel.close();
    channel.close();
    assert.deepEqual(await collected, [], 'released rather than hung');
  });

  test('fail() puts a declared failure in the flow; the railway carries it', async (assert) => {
    const channel = Stream.channel<number, Failure.Of<typeof BadRow>>();
    const collected = channel.stream.partition();
    channel.emit(1);
    channel.fail(BadRow({ line: 7 }));
    channel.emit(2);
    channel.close();

    const { values, errors } = await collected;
    assert.deepEqual(values, [1, 2], 'values keep flowing past the failure');
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].data.line, 7);
  });

  test('abort() rejects the consuming Task — the bug tier, not the flow', async (assert) => {
    const channel = Stream.channel<number>();
    const collected = channel.stream.collect();
    channel.emit(1);
    channel.abort(new TypeError('producer exploded'));
    await assert.rejects(collected, TypeError, 'a bug is never boxed into the element flow');
    assert.true(channel.closed);
  });

  test('emitting after close or abort is ignored rather than thrown', (assert) => {
    const channel = Stream.channel<number>();
    channel.close();
    assert.false(channel.emit(1), 'the producer is told there is nowhere to put it');
    assert.strictEqual(channel.buffered, 0);
  });

  test('a second consumer throws rather than silently splitting the elements', async (assert) => {
    const channel = Stream.channel<number>();
    channel.emit(1);
    channel.close();
    assert.deepEqual(await channel.stream.collect(), [1]);
    await assert.rejects(channel.stream.collect(), /already been consumed/);
  });
});

module('Stream | channel backpressure', { concurrency: true }, () => {
  test('emit() reports whether there is room left, Node write() style', (assert) => {
    const channel = Stream.channel<number>({ capacity: 2 });
    assert.true(channel.emit(1), 'room to spare');
    assert.false(channel.emit(2), 'that was the last slot — slow down if you can');
  });

  test('dropOldest keeps the newest and counts what went', async (assert) => {
    const discarded: number[] = [];
    const channel = Stream.channel<number>({
      capacity: 2,
      onDiscard: (element) => void discarded.push(element as number),
    });
    channel.emit(1);
    channel.emit(2);
    channel.emit(3);
    channel.close();

    assert.deepEqual(await channel.stream.collect(), [2, 3], 'the oldest was evicted');
    assert.strictEqual(channel.dropped, 1);
    assert.deepEqual(discarded, [1], 'onDiscard is handed what was lost, not what caused it');
  });

  test('dropNewest keeps the oldest and refuses the arrival', async (assert) => {
    const discarded: number[] = [];
    const channel = Stream.channel<number>({
      capacity: 2,
      overflow: 'dropNewest',
      onDiscard: (element) => void discarded.push(element as number),
    });
    channel.emit(1);
    channel.emit(2);
    channel.emit(3);
    channel.close();

    assert.deepEqual(await channel.stream.collect(), [1, 2]);
    assert.deepEqual(discarded, [3], 'the arrival was the casualty');
  });

  test('a producer that honours emit()/ready() loses nothing at any capacity', async (assert) => {
    // The whole point of the pair, and the only way an unslowable-looking producer becomes a
    // pausable one: 200 elements through a buffer of 10, nothing dropped. Merely yielding to the
    // microtask queue between emits is NOT enough — the consumer's own path through the generator
    // costs several turns per element, so a producer that only awaits `Promise.resolve()` still
    // outruns it by a factor of three and overflows. Waiting on demand is what keeps pace.
    const channel = Stream.channel<number>({ capacity: 10 });
    const seen: number[] = [];
    const produce = (async () => {
      for (let index = 0; index < 200; index++) {
        if (!channel.emit(index)) await channel.ready();
      }
      channel.close();
    })();

    await Promise.all([channel.stream.forEach((n) => void seen.push(n)), produce]);
    assert.strictEqual(channel.dropped, 0, 'nothing lost');
    assert.deepEqual(seen.length, 200, 'and everything arrived');
  });

  test('the same producer past a capacity nobody is draining drops the excess', async (assert) => {
    const channel = Stream.channel<number>({ capacity: 10 });
    for (let index = 0; index < 500; index++) channel.emit(index);
    channel.close();

    assert.strictEqual(
      channel.dropped,
      490,
      'bounded memory costs elements — there is no third option',
    );
    assert.deepEqual(
      await channel.stream.take(1).collect(),
      [490],
      'and the newest are what survived',
    );
  });

  test('ready() resolves once the consumer has made room', async (assert) => {
    const channel = Stream.channel<number>({ capacity: 1 });
    channel.emit(1);

    let resumed = false;
    const waiting = channel.ready().then(() => void (resumed = true));
    await Promise.resolve();
    assert.false(resumed, 'still full — the producer waits');

    // Awaited together: the consuming Task is lazy, so `collect()` alone attaches nothing and
    // the slot would never free.
    const [, collected] = await Promise.all([waiting, channel.stream.take(1).collect()]);
    assert.true(resumed, 'the take freed the slot');
    assert.deepEqual(collected, [1]);
  });

  test('ready() resolves immediately when there is already room', async (assert) => {
    const channel = Stream.channel<number>({ capacity: 4 });
    await channel.ready();
    assert.true(true, 'no wait when nothing is full');
  });

  test('a consumer that leaves early releases a producer parked on ready()', async (assert) => {
    const channel = Stream.channel<number>({ capacity: 1 });
    channel.emit(1);
    channel.emit(2);
    const waiting = channel.ready();

    assert.deepEqual(await channel.stream.take(1).collect(), [2], 'take(1) ends the consumer');
    await waiting;
    assert.true(channel.closed, 'an abandoned channel stops accepting rather than leaking');
  });
});

module('Stream | channel demand', { concurrency: true }, () => {
  test('onDemand fires exactly once, when a consumer actually starts draining', async (assert) => {
    let started = 0;
    const channel = Stream.channel<number>({ onDemand: () => void (started += 1) });
    const collected = channel.stream.collect();
    assert.strictEqual(started, 0, 'building the channel and the consumer started nothing');

    channel.close();
    await collected;
    assert.strictEqual(started, 1, 'awaiting the consumer is what started the producer');
  });

  test('a producer deferred to onDemand emits nothing into a buffer nobody wanted', async (assert) => {
    // The lazy-start property: a producer that can wait for demand never races ahead of a
    // consumer that has not arrived, which is the difference between the two rows of the
    // measurement in `channel`'s docs. Here the whole run happens after the consumer is real.
    const channel: ReturnType<typeof Stream.channel<number>> = Stream.channel<number>({
      capacity: 50,
      onDemand: () => {
        void (async () => {
          for (let index = 0; index < 200; index++) {
            if (!channel.emit(index)) await channel.ready();
          }
          channel.close();
        })();
      },
    });
    assert.strictEqual(channel.buffered, 0, 'nothing emitted before anyone asked');

    assert.strictEqual((await channel.stream.collect()).length, 200);
    assert.strictEqual(channel.dropped, 0, 'and nothing was lost getting there');
  });

  test('a consumer attaches when its Task is awaited, not when it is built', async (assert) => {
    // The sharp edge of a lazy module meeting a live producer, pinned so it cannot drift:
    // `collect()` returns a Task and Tasks do nothing until awaited, so building a consumer does
    // NOT start draining. Anything emitted in between is buffered — which is what `capacity` is
    // for, and what `onDemand` exists to let a deferrable producer avoid entirely.
    let started = 0;
    const channel = Stream.channel<number>({ onDemand: () => void (started += 1) });
    const collected = channel.stream.collect();
    channel.emit(1);
    assert.strictEqual(started, 0, 'building the consumer attached nothing');
    assert.strictEqual(channel.buffered, 1, 'so the emit went to the buffer');

    channel.close();
    assert.deepEqual(await collected, [1], 'and awaiting is what drains it');
    assert.strictEqual(started, 1);
  });

  test('composes with every transform — it is an ordinary Stream', async (assert) => {
    const channel = Stream.channel<number>();
    const collected = channel.stream
      .filter((n) => n % 2 === 0)
      .map((n) => n * 10)
      .take(2)
      .collect();
    for (let index = 0; index < 10; index++) channel.emit(index);

    assert.deepEqual(await collected, [0, 20]);
  });
});

// ── The terminal fold ─────────────────────────────────────────────────────────

module('Stream | reduce', { concurrency: true }, () => {
  test('folds every value into one', async (assert) => {
    assert.strictEqual(await Stream.from([1, 2, 3]).reduce((sum, n) => sum + n, 0), 6);
  });

  test('the accumulator type is the seed type, not the element type', async (assert) => {
    const joined = await Stream.from([1, 2, 3]).reduce((text, n) => `${text}${n}`, '');
    assert.strictEqual(joined, '123');
  });

  test('an empty stream answers with the seed rather than raising', async (assert) => {
    assert.strictEqual(await Stream.from([] as number[]).reduce((sum, n) => sum + n, 0), 0);
  });

  test('the index is passed, like every other element-wise member', async (assert) => {
    const pairs = await Stream.from(['a', 'b']).reduce<string[]>(
      (acc, value, index) => [...acc, `${index}:${value}`],
      [],
    );
    assert.deepEqual(pairs, ['0:a', '1:b']);
  });

  test('an async reducer is awaited per element', async (assert) => {
    const total = await Stream.from([1, 2, 3]).reduce(
      async (sum, n) => sum + (await Promise.resolve(n)),
      0,
    );
    assert.strictEqual(total, 6);
  });

  test('fail-fasts on the first failure element, as a declared rejection', async (assert) => {
    const outcome = await Stream.from([1, BadRow({ line: 9 }), 3])
      .reduce((sum, n) => sum + n, 0)
      .result();
    assert.true(BadRow.is(outcome));
    assert.strictEqual((outcome as Failure.Of<typeof BadRow>).data.line, 9);
  });

  test('does not buffer the source — the whole point of a terminal fold', async (assert) => {
    let live = 0;
    const total = await Stream.from(
      (function* () {
        for (let index = 1; index <= 100_000; index++) {
          live += 1;
          yield index;
        }
      })(),
    ).reduce((sum, n) => sum + n, 0);
    assert.strictEqual(total, 5_000_050_000);
    assert.strictEqual(live, 100_000, 'every element passed through, none were kept');
  });

  test('a throw in the reducer stays a bug', async (assert) => {
    await assert.rejects(
      Stream.from([1]).reduce(() => {
        throw new TypeError('boom');
      }, 0),
      TypeError,
    );
  });
});

// ── Sequencing: what awaits what, and where to go when you want parallelism ──

module('Stream | per-element sequencing', { concurrency: true }, () => {
  // Asserted on OBSERVED concurrency rather than wall-clock, so a loaded CI box cannot
  // turn a contract into a flake. `asyncStream`'s own bounding is covered in its module;
  // these two pin the contrast the `map`/`each` docs now draw.
  const watcher = () => {
    const state = { live: 0, peak: 0 };
    const fn = async (value: number) => {
      state.live += 1;
      state.peak = Math.max(state.peak, state.live);
      await new Promise((resolve) => setTimeout(resolve, 5));
      state.live -= 1;

      return value;
    };

    return { state, fn };
  };

  test('map awaits one element at a time', async (assert) => {
    const { state, fn } = watcher();
    await Stream.from([1, 2, 3, 4]).map(fn).collect();

    assert.strictEqual(state.peak, 1, 'one suspended generator has one resume point');
  });

  test('each drains one element at a time', async (assert) => {
    const { state, fn } = watcher();
    await Stream.from([1, 2, 3, 4]).forEach(fn);

    assert.strictEqual(state.peak, 1, 'the next element is not pulled until fn settles');
  });

  test('asyncStream is the escape hatch, bounded by maxConcurrency', async (assert) => {
    const { state, fn } = watcher();
    await Stream.asyncStream([1, 2, 3, 4, 5, 6], fn, { maxConcurrency: 3 }).collect();

    assert.strictEqual(state.peak, 3, 'exactly the window asked for — never more, never one');
  });
});

module('Stream | channel overflow: fail', { concurrency: true }, () => {
  test('ends with a ChannelOverflow element instead of losing anything quietly', async (assert) => {
    const channel = Stream.channel<number>({ capacity: 2, overflow: 'fail' });
    channel.emit(1);
    channel.emit(2);
    assert.false(channel.emit(3), 'the third has nowhere to go');

    const { values, errors } = await channel.stream.partition();
    assert.deepEqual(values, [1, 2], 'everything already accepted still arrives');
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, 'ChannelOverflow');
    assert.strictEqual(errors[0].data.capacity, 2, 'and says what it could hold');
  });

  test('the failure is the LAST element, not a replacement for the prefix', async (assert) => {
    const channel = Stream.channel<number>({ capacity: 2, overflow: 'fail' });
    for (const n of [1, 2, 3, 4]) channel.emit(n);

    const elements = await channel.stream.results();
    assert.strictEqual(elements.length, 3, 'two values then the ending');
    assert.true(Failure.is(elements[2]));
  });

  test('fail-fast consumers reject with it, declared and typed', async (assert) => {
    const channel = Stream.channel<number>({ capacity: 1, overflow: 'fail' });
    channel.emit(1);
    channel.emit(2);

    const outcome = await channel.stream.collect().result();
    assert.true(Failure.is(outcome), 'collect() fail-fasts on it like any other failure element');
  });

  test('the channel closes — a fatal overflow is not a hiccup', (assert) => {
    const channel = Stream.channel<number>({ capacity: 1, overflow: 'fail' });
    channel.emit(1);
    channel.emit(2);

    assert.true(channel.closed);
    assert.false(channel.emit(3), 'nothing more is accepted');
  });

  test('a channel that never overflows never mentions ChannelOverflow', async (assert) => {
    const channel = Stream.channel<number>({ capacity: 10, overflow: 'fail' });
    channel.emit(1);
    channel.emit(2);
    channel.close();

    assert.deepEqual(await channel.stream.collect(), [1, 2], 'the mode costs nothing when unused');
    assert.strictEqual(channel.dropped, 0);
  });

  test('onDiscard still reports the element that could not be taken', (assert) => {
    const refused: number[] = [];
    const channel = Stream.channel<number>({
      capacity: 1,
      overflow: 'fail',
      onDiscard: (element) => void refused.push(element as number),
    });
    channel.emit(1);
    channel.emit(2);

    assert.deepEqual(refused, [2], 'the arrival that triggered the failure');
  });
});

module('Stream | mapConcurrent', { concurrency: true }, () => {
  test('fans out mid-pipeline, bounded by maxConcurrency', async (assert) => {
    let live = 0;
    let peak = 0;
    const rows = await Stream.from([1, 2, 3, 4, 5, 6])
      .filter((n) => n % 2 === 0)
      .mapConcurrent(
        async (n) => {
          live += 1;
          peak = Math.max(peak, live);
          await new Promise((resolve) => setTimeout(resolve, 5));
          live -= 1;

          return n * 10;
        },
        { maxConcurrency: 2 },
      )
      .collect();

    assert.deepEqual(rows, [20, 40, 60], 'source order by default');
    assert.strictEqual(peak, 2, 'and never wider than asked — mid-chain, after a filter');
  });

  test('composes downstream too — it is an ordinary stage', async (assert) => {
    const total = await Stream.from([1, 2, 3, 4])
      .mapConcurrent((n) => n * 2, { maxConcurrency: 4 })
      .filter((n) => n > 2)
      .reduce((sum, n) => sum + n, 0);

    assert.strictEqual(total, 18, '4 + 6 + 8');
  });

  test('failure elements ride past unmapped, like every other transform', async (assert) => {
    const { values, errors } = await Stream.from([1, BadRow({ line: 2 }), 3])
      .mapConcurrent((n) => (n as number) * 10, { maxConcurrency: 2 })
      .partition();

    assert.deepEqual(values, [10, 30]);
    assert.strictEqual(errors.length, 1, 'the railway holds through a concurrent stage');
  });
});

// ── The short-circuiting query terminals ─────────────────────────────────────

module('Stream | some / every / find', { concurrency: true }, () => {
  const counting = () => {
    const state = { pulled: 0 };
    const stream = Stream.from(
      (function* () {
        for (;;) yield ++state.pulled;
      })(),
    );

    return { state, stream };
  };

  test('some stops pulling at the first match', async (assert) => {
    const { state, stream } = counting();

    assert.true(await stream.some((n) => n > 2));
    assert.strictEqual(state.pulled, 3, 'an infinite source is fine — it never reached a fourth');
  });

  test('some is false when nothing matches', async (assert) => {
    assert.false(await Stream.from([1, 2]).some((n) => n > 5));
  });

  test('every stops pulling at the first failure to match', async (assert) => {
    const { state, stream } = counting();

    assert.false(await stream.every((n) => n < 3));
    assert.strictEqual(state.pulled, 3, 'stopped on the one that broke it');
  });

  test('every is vacuously true on an empty stream, like Array.prototype.every', async (assert) => {
    assert.true(await Stream.from([] as number[]).every(() => false));
  });

  test('find returns the first match and stops', async (assert) => {
    const { state, stream } = counting();

    assert.strictEqual(await stream.find((n) => n > 1), 2);
    assert.strictEqual(state.pulled, 2);
  });

  test('find returns undefined when nothing matches — absence is not a failure', async (assert) => {
    assert.strictEqual(await Stream.from([1, 2]).find((n) => n > 5), undefined);
  });

  test('an async predicate is awaited', async (assert) => {
    assert.true(await Stream.from([1, 2]).some(async (n) => (await Promise.resolve(n)) === 2));
  });

  test('all three fail-fast on a failure element, declared and typed', async (assert) => {
    const withFailure = () => Stream.from([1, BadRow({ line: 4 }), 3]);

    for (const outcome of [
      await withFailure()
        .some((n) => n > 99)
        .result(),
      await withFailure()
        .every(() => true)
        .result(),
      await withFailure()
        .find((n) => n > 99)
        .result(),
    ]) {
      assert.true(BadRow.is(outcome), 'a question about values cannot be answered past a failure');
    }
  });

  test('a failure AFTER the short-circuit is never reached', async (assert) => {
    const answer = await Stream.from([1, 2, BadRow({ line: 9 })]).some((n) => n === 1);

    assert.true(answer, 'short-circuiting means the failure was never pulled');
  });
});

// ── The static mirrors ───────────────────────────────────────────────────────
//
// Per-member behaviour is covered by the instance tests above: every static is a one-line
// delegation, so testing both spellings would test the same code twice. What is NOT covered
// there is the BRIDGE — that a static exists for every member and forwards faithfully — and
// that is what these two tests pin. A member added later without its mirror fails the first.

module('Stream | static mirrors', { concurrency: true }, () => {
  const MIRRORED = [
    'map',
    'filter',
    'reject',
    'flatMap',
    'take',
    'drop',
    'takeWhile',
    'dropWhile',
    'takeEvery',
    'dropEvery',
    'mapEvery',
    'withIndex',
    'intersperse',
    'dedup',
    'dedupBy',
    'uniq',
    'uniqBy',
    'tap',
    'into',
    'chunkEvery',
    'chunkBy',
    'chunkWhile',
    'through',
    'mapConcurrent',
    'collect',
    'results',
    'partition',
    'reduce',
    'some',
    'every',
    'find',
    'forEach',
    'run',
  ] as const;

  test('every instance member has a static counterpart', (assert) => {
    const instance = Stream.from([]) as unknown as Record<string, unknown>;
    const missing = MIRRORED.filter(
      (name) => typeof (Stream as unknown as Record<string, unknown>)[name] !== 'function',
    );
    const notOnInstance = MIRRORED.filter((name) => typeof instance[name] !== 'function');

    assert.deepEqual(missing, [], 'no member is method-only');
    assert.deepEqual(notOnInstance, [], 'and the list itself has not gone stale');
  });

  test('a static produces what the instance spelling does', async (assert) => {
    // A representative of each shape — transform, terminal, and one that takes options — rather
    // than all 33: the delegation is the same line in every case.
    assert.deepEqual(
      await Stream.map([1, 2, 3], (n) => n * 2).collect(),
      await Stream.from([1, 2, 3])
        .map((n) => n * 2)
        .collect(),
      'transform',
    );
    assert.deepEqual(
      await Stream.reduce([1, 2, 3], (sum, n) => sum + n, 0),
      await Stream.from([1, 2, 3]).reduce((sum, n) => sum + n, 0),
      'terminal',
    );
    assert.deepEqual(
      await Stream.mapConcurrent([1, 2, 3], (n) => n * 2, { maxConcurrency: 2 }).collect(),
      await Stream.from([1, 2, 3])
        .mapConcurrent((n) => n * 2, { maxConcurrency: 2 })
        .collect(),
      'options bag forwarded',
    );
  });

  test('the railway survives the static spelling', async (assert) => {
    const { values, errors } = await Stream.partition([1, BadRow({ line: 2 }), 3]);

    assert.deepEqual(values, [1, 3]);
    assert.strictEqual(errors.length, 1, 'failures are lifted by `from`, not swallowed');
  });
});

// ── The railway, member by member ────────────────────────────────────────────
//
// One table stating, for every transform, exactly what a failure element does to it. This is the
// module's two-rule taxonomy made checkable in one place:
//
//   POSITIONAL ops (take, drop, intersperse) count EVERY element — a failure occupies a slot,
//                  because discarding a prefix is a decision about position, not about values.
//   VALUE ops      (predicates, folds, chunkers, dedup/uniq) speak only about values — a failure
//                  passes untested, invisible to a predicate, a counter or an accumulator.
//
// A new transform with no row here is a transform whose ruling nobody wrote down.

module('Stream | the railway, member by member', { concurrency: true }, () => {
  const IN = () => Stream.from([1, BadRow({ line: 9 }), 2]);

  const CASES: Array<{
    name: string;
    kind: 'positional' | 'value';
    apply: (s: ReturnType<typeof IN>) => {
      partition(): Promise<{ values: unknown[]; errors: unknown[] }>;
    };
    values: unknown[];
    why: string;
  }> = [
    {
      name: 'map',
      kind: 'value',
      apply: (s) => s.map((n) => n * 10),
      values: [10, 20],
      why: 'fn never sees the failure',
    },
    {
      name: 'filter',
      kind: 'value',
      apply: (s) => s.filter((n) => n > 0),
      values: [1, 2],
      why: 'the predicate is not consulted about a failure',
    },
    {
      name: 'reject',
      kind: 'value',
      apply: (s) => s.reject((n) => n === 1),
      values: [2],
      why: 'rejecting values cannot reject a failure',
    },
    {
      name: 'flatMap',
      kind: 'value',
      apply: (s) => s.flatMap((n) => [n, n]),
      values: [1, 1, 2, 2],
      why: 'the failure is not expanded, it rides past',
    },
    {
      name: 'take(2)',
      kind: 'positional',
      apply: (s) => s.take(2),
      values: [1],
      why: 'the failure occupied the second slot',
    },
    {
      name: 'drop(1)',
      kind: 'positional',
      apply: (s) => s.drop(1),
      values: [2],
      why: 'the dropped prefix was the value 1, so the failure survives',
    },
    {
      name: 'takeWhile',
      kind: 'value',
      apply: (s) => s.takeWhile((n) => n < 2),
      values: [1],
      why: 'the window closed on the value 2; the failure inside it passed',
    },
    {
      name: 'dropWhile',
      kind: 'value',
      apply: (s) => s.dropWhile((n) => n < 2),
      values: [2],
      why: 'a failure is emitted even while values are being dropped',
    },
    {
      name: 'takeEvery(2)',
      kind: 'value',
      apply: (s) => s.takeEvery(2),
      values: [1],
      why: 'the failure did not advance the value counter',
    },
    {
      name: 'dropEvery(2)',
      kind: 'value',
      apply: (s) => s.dropEvery(2),
      values: [2],
      why: 'same counter, other end',
    },
    {
      name: 'mapEvery(2)',
      kind: 'value',
      apply: (s) => s.mapEvery(2, (n) => n * 10),
      values: [10, 2],
      why: 'only value positions are counted for mapping',
    },
    {
      name: 'withIndex',
      kind: 'value',
      apply: (s) => s.withIndex(),
      values: [
        [1, 0],
        [2, 1],
      ],
      why: 'the index numbers values, not elements',
    },
    {
      name: 'intersperse',
      kind: 'positional',
      apply: (s) => s.intersperse(0),
      values: [1, 0, 0, 2],
      why: 'a separator goes between every ELEMENT, the failure included',
    },
    {
      name: 'dedup',
      kind: 'value',
      apply: (s) => s.dedup(),
      values: [1, 2],
      why: 'a failure is transparent to the last-seen memory',
    },
    {
      name: 'dedupBy',
      kind: 'value',
      apply: (s) => s.dedupBy((n) => n),
      values: [1, 2],
      why: 'the key function never sees a failure',
    },
    {
      name: 'uniq',
      kind: 'value',
      apply: (s) => s.uniq(),
      values: [1, 2],
      why: 'a failure is never added to the seen set',
    },
    {
      name: 'uniqBy',
      kind: 'value',
      apply: (s) => s.uniqBy((n) => n),
      values: [1, 2],
      why: 'same set, keyed',
    },
    {
      name: 'scan',
      kind: 'value',
      apply: (s) => s.scan((a, b) => a + b),
      values: [1, 3],
      why: 'the accumulator is untouched by the failure',
    },
    {
      name: 'tap',
      kind: 'value',
      apply: (s) => s.tap(() => {}),
      values: [1, 2],
      why: 'the side effect does not fire for a failure',
    },
    {
      name: 'chunkEvery(2)',
      kind: 'value',
      apply: (s) => s.chunkEvery(2),
      values: [[1, 2]],
      why: 'a bad row never voids the batch around it — the failure passes BETWEEN chunks',
    },
    {
      name: 'chunkBy',
      kind: 'value',
      apply: (s) => s.chunkBy((n) => n),
      values: [[1], [2]],
      why: 'the key change is judged on values only',
    },
  ];

  for (const { name, kind, apply, values, why } of CASES) {
    test(`${name} is a ${kind} op — ${why}`, async (assert) => {
      const { values: got, errors } = await apply(IN()).partition();

      assert.deepEqual(got, values, `${name}: values`);
      assert.strictEqual(errors.length, 1, `${name}: the failure survived, exactly once`);
      assert.true(BadRow.is(errors[0]), `${name}: and arrived intact, still typed`);
      assert.strictEqual(
        (errors[0] as Failure.Of<typeof BadRow>).data.line,
        9,
        `${name}: with its payload — no re-wrapping along the way`,
      );
    });
  }

  test('every transform in the module has a row above', (assert) => {
    const RULED = new Set(CASES.map(({ name }) => name.replace(/\(.*\)$/, '')));
    // `through` owns its own ruling by design (the user's generator sees the raw flow), and
    // `into`/`mapConcurrent` are pinned in their own modules.
    const EXEMPT = new Set(['through', 'into', 'mapConcurrent']);
    const TRANSFORMS = [
      'map',
      'filter',
      'reject',
      'flatMap',
      'take',
      'drop',
      'takeWhile',
      'dropWhile',
      'takeEvery',
      'dropEvery',
      'mapEvery',
      'withIndex',
      'intersperse',
      'dedup',
      'dedupBy',
      'uniq',
      'uniqBy',
      'scan',
      'tap',
      'chunkEvery',
      'chunkBy',
      'chunkWhile',
      'through',
      'into',
      'mapConcurrent',
    ];
    const unruled = TRANSFORMS.filter((n) => !RULED.has(n) && !EXEMPT.has(n));

    assert.deepEqual(unruled, ['chunkWhile'], 'only chunkWhile is ruled elsewhere');
  });
});

// ── Consuming the same Stream more than once ─────────────────────────────────
//
// A Stream is a RECIPE, not a result: `#open` is a thunk, so every terminal opens a fresh pass.
// Nothing is memoised. That is Elixir's `Stream` and Rust's `Iterator`, and it has four
// consequences a reader should meet here rather than in production. The array is the cache: if
// you want one pass, take one — `const rows = await stream.collect()` — and work on `rows`.

module('Stream | re-consumption', { concurrency: true }, () => {
  test('a re-iterable source answers twice, but does the WORK twice', async (assert) => {
    let work = 0;
    const base = Stream.from([1, 2, 3]).map((n) => {
      work += 1;

      return n * 10;
    });

    assert.deepEqual(await base.collect(), [10, 20, 30]);
    assert.deepEqual(await base.collect(), [10, 20, 30], 'same answer');
    assert.strictEqual(work, 6, 'and six calls for three elements — nothing was cached');
  });

  test('branching recomputes the shared upstream per branch', async (assert) => {
    // The one that surprises people: `shared` looks like a variable holding results. It is a
    // description, so each branch re-derives it from the source.
    let expensive = 0;
    const shared = Stream.from([1, 2, 3, 4]).map((n) => {
      expensive += 1;

      return n;
    });

    assert.deepEqual(await shared.filter((n) => n % 2 === 0).collect(), [2, 4]);
    assert.deepEqual(await shared.filter((n) => n % 2 === 1).collect(), [1, 3]);
    assert.strictEqual(expensive, 8, 'four per branch, not four in total');
  });

  test('side effects fire once per consumption', async (assert) => {
    const seen: number[] = [];
    const tapped = Stream.from([1, 2]).tap((n) => void seen.push(n));
    await tapped.collect();
    await tapped.collect();

    assert.deepEqual(seen, [1, 2, 1, 2], 'tap is not a cache either');
  });

  test('a one-shot source is empty the second time — silently', async (assert) => {
    const live = Stream.from(
      (async function* () {
        yield 1;
        yield 2;
      })(),
    );

    assert.deepEqual(await live.collect(), [1, 2]);
    assert.deepEqual(await live.collect(), [], 'exhausted; no error, because none is owed');
  });

  test('two consumers racing a one-shot source SPLIT it between them', async (assert) => {
    // The sharpest edge in the module, pinned so nobody discovers it in production: this is not
    // an empty result you would notice, it is a plausible-looking partial one. Deliberately left
    // unguarded — a Stream cannot tell a one-shot source from a re-iterable one without
    // heuristics that would catch generators and miss `ReadableStream`, so the honest rule stays
    // "re-iterability follows the source". Consume once, or consume an array.
    const raced = Stream.from(
      (async function* () {
        yield 1;
        yield 2;
        yield 3;
      })(),
    );

    const [left, right] = await Promise.all([raced.collect(), raced.collect()]);

    assert.strictEqual(left.length + right.length, 3, 'between them they got every element once');
    assert.notDeepEqual(left, [1, 2, 3], 'but neither consumer got the whole stream');
  });

  test('collecting once and reusing the array is the fix', async (assert) => {
    let work = 0;
    const rows = await Stream.from([1, 2, 3])
      .map((n) => {
        work += 1;

        return n * 10;
      })
      .collect();

    assert.deepEqual(
      rows.filter((n) => n > 10),
      [20, 30],
    );
    assert.deepEqual(
      rows.filter((n) => n < 30),
      [10, 20],
    );
    assert.strictEqual(work, 3, 'one pass, however many times the array is read');
  });
});
