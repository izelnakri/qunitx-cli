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
    assert.deepEqual(await stream.take(2).values(), [10, 20]);
    assert.strictEqual(pulled, 2, 'only the taken elements were pulled — backpressure');
  });

  test('a Stream from a re-iterable source is re-consumable', async (assert) => {
    const stream = Stream.from([1, 2]);
    assert.deepEqual(await stream.values(), [1, 2]);
    assert.deepEqual(await stream.values(), [1, 2], 'arrays re-open per consumer');
  });

  test('unfold grows lazily from a seed and stops on null', async (assert) => {
    let fetches = 0;
    const pages = Stream.unfold(1, (page) => {
      fetches += 1;
      return page > 3 ? null : ([`page-${page}`, page + 1] as const);
    });
    assert.deepEqual(await pages.values(), ['page-1', 'page-2', 'page-3']);
    assert.deepEqual(await pages.take(1).values(), ['page-1']);
    assert.strictEqual(fetches, 5, 'take(1) fetched one page, not all');
  });

  test('lines splits across chunk boundaries and flushes the tail', async (assert) => {
    const encode = (s: string) => new TextEncoder().encode(s);
    const chunks = [encode('alpha\nbe'), encode('ta\nga'), encode('mma')];
    assert.deepEqual(await Stream.lines(chunks).values(), ['alpha', 'beta', 'gamma']);
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
    await assert.rejects(buggy.values(), TypeError);
    await assert.rejects(buggy.results(), TypeError, 'even the keep-everything consumer');
  });
});

// ── Consumers ─────────────────────────────────────────────────────────────────

module('Stream | consumers', { concurrency: true }, () => {
  const withFailure = () => Stream.from([1, BadRow({ line: 9 }), 3]);

  test('values() fail-fasts on the first failure element, as a declared rejection', async (assert) => {
    const outcome = await withFailure().values().result(); // number[] | BadRow — bare
    assert.true(BadRow.is(outcome));
    assert.strictEqual((outcome as Failure.Of<typeof BadRow>).data.line, 9);
  });

  test('results() keeps everything positionally, failures included', async (assert) => {
    const outcomes = await withFailure().results();
    assert.strictEqual(outcomes.length, 3);
    assert.true(Failure.is(outcomes[1]));
  });

  test('each() drains with side effects and fail-fasts like values()', async (assert) => {
    const seen: number[] = [];
    await Stream.from([1, 2]).each((n) => void seen.push(n));
    assert.deepEqual(seen, [1, 2]);
    await assert.rejects(
      withFailure().each(() => {}),
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
// consume failures (values().result(), partition()) would report into this test's collector.
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
    assert.deepEqual(await Stream.concat([1], [2, 3]).values(), [1, 2, 3]);
    assert.deepEqual(await Stream.duplicate('x', 2).values(), ['x', 'x']);
    assert.deepEqual(await Stream.fromIndex(5).take(2).values(), [5, 6]);
  });

  test('cycle, iterate and repeatedly are infinite until bounded', async (assert) => {
    assert.deepEqual(await Stream.cycle([1, 2]).take(5).values(), [1, 2, 1, 2, 1]);
    assert.deepEqual(
      await Stream.iterate(1, (n) => n * 3)
        .take(3)
        .values(),
      [1, 3, 9],
    );
    let calls = 0;
    assert.deepEqual(
      await Stream.repeatedly(() => ++calls)
        .take(2)
        .values(),
      [1, 2],
    );
    assert.deepEqual(await Stream.cycle([]).values(), [], 'an empty cycle ends, never spins');
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
    assert.deepEqual(await Stream.from([0, 1, 2, 3, 4]).takeEvery(2).values(), [0, 2, 4]);
    assert.deepEqual(await Stream.from([0, 1, 2, 3, 4]).dropEvery(2).values(), [1, 3]);
    const everied = await withFailure()
      .mapEvery(2, (n) => n * 10)
      .partition();
    assert.deepEqual(everied.values, [10, 2, 30], 'failure did not advance the value counter');
  });

  test('reject, intersperse and withIndex', async (assert) => {
    assert.deepEqual(
      await Stream.from([1, 2, 3])
        .reject((n) => n === 2)
        .values(),
      [1, 3],
    );
    assert.deepEqual(await Stream.from([1, 2]).intersperse(0).values(), [1, 0, 2]);
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
    assert.deepEqual(await Stream.from([1, 2, 1, 3]).uniq().values(), [1, 2, 3]);
  });

  test('scan folds values, seeded or seeded-by-first, and passes failures', async (assert) => {
    assert.deepEqual(
      await Stream.from([1, 2, 3])
        .scan((a, n) => a + n)
        .values(),
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
    assert.deepEqual(await cleaned.values(), [10, 20]);
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
    assert.deepEqual(await resource.take(2).values(), [0, 1]);
    assert.true(cleaned, 'take() closed the source — no leaked handle');
  });
});
