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
