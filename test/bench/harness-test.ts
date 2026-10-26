import { module, test } from 'qunitx';
import { installBench, type BenchEntry, type BenchStats } from '../../lib/bench/harness.ts';
import '../helpers/custom-asserts.ts';

// Fast enough for a unit test: a bench is measured for a few milliseconds.
const TIMING = { warmupMs: 1, sampleMs: 1, budgetMs: 4, minSamples: 3, maxSamples: 1_000 };
const harness = () =>
  installBench({ origin: 'file:///a.bench.ts', highPrecision: true, timing: TIMING });
const stats = (entry: BenchEntry): BenchStats => (entry.results[0] as { ok: BenchStats }).ok;

module('Bench | harness | declaring', { concurrency: true }, () => {
  test("every one of Deno.bench's forms, a named function's name when none is given", async (assert) => {
    const { bench, run } = harness();
    function named() {}
    bench('name and fn', () => {});
    bench({ name: 'definition', fn: () => {} });
    bench(named);
    bench('name, options and fn', { group: 'g' }, () => {});
    bench({ name: 'options with a name, and fn', baseline: true }, () => {});
    bench({ group: 'g' }, function fromFunction() {});
    const { benches, declared } = await run({});

    assert.equal(declared, 6);
    assert.deepEqual(
      benches.map((entry) => [entry.name, entry.group, entry.baseline, entry.origin]),
      [
        ['name and fn', null, false, 'file:///a.bench.ts'],
        ['definition', null, false, 'file:///a.bench.ts'],
        ['named', null, false, 'file:///a.bench.ts'],
        ['options with a name, and fn', null, true, 'file:///a.bench.ts'],
        ['name, options and fn', 'g', false, 'file:///a.bench.ts'],
        ['fromFunction', 'g', false, 'file:///a.bench.ts'],
      ],
      'ungrouped first, then each group, as deno bench orders them',
    );
  });

  test('a bench without a function or a name, or with a count that is no count, is refused', (assert) => {
    const { bench } = harness();

    assert.throws(() => bench('no fn'), /the bench has no fn/);
    assert.throws(
      () => bench(() => {}),
      /name can't be empty/,
      'an anonymous function has no name',
    );
    assert.throws(() => bench({ name: 'x', n: 0, fn() {} }), /"x": n must be a whole number/);
    assert.throws(
      () => bench({ name: 'x', warmup: 1.5, fn() {} }),
      /"x": warmup must be a whole number/,
    );
    assert.throws(() => bench(42), /expected a function, a name and a function, or a definition/);
  });
});

module('Bench | harness | choosing', { concurrency: true }, () => {
  test('ignored benches are left out; `only` runs those alone and says so; a filter by name or /regex/', async (assert) => {
    const first = harness();
    first.bench({ name: 'kept', fn() {} });
    first.bench({ name: 'skipped', ignore: true, fn() {} });
    const second = harness();
    second.bench({ name: 'focused', only: true, fn() {} });
    second.bench({ name: 'other', fn() {} });
    const third = harness();
    for (const name of ['render list', 'render row', 'parse']) third.bench(name, () => {});

    const plain = await first.run({});
    const only = await second.run({});
    const named = await third.run({ filter: 'render' });
    const regex = await third.run({ filter: '/^(parse|render row)$/' });

    assert.deepEqual([plain.benches.map((entry) => entry.name), plain.onlyUsed], [['kept'], false]);
    assert.deepEqual([only.benches.map((entry) => entry.name), only.onlyUsed], [['focused'], true]);
    assert.deepEqual(
      named.benches.map((entry) => entry.name),
      ['render list', 'render row'],
    );
    assert.deepEqual(
      regex.benches.map((entry) => entry.name),
      ['render row', 'parse'],
    );
  });
});

module('Bench | harness | measuring', { concurrency: true }, () => {
  test('samples in order, in nanoseconds per iteration; batched, so a fast bench has many iterations a sample', async (assert) => {
    // Measured up to three times: a run descheduled while it sizes its batches, as on a loaded CI
    // machine, keeps one iteration a sample, and is no evidence that batching is broken.
    const measure = async () => {
      const { bench, run } = harness();
      let calls = 0;
      bench('sum', () => {
        calls++;
        let total = 0;
        for (let index = 0; index < 100; index++) total += index;
        return total;
      });
      const [entry] = (await run({})).benches;
      return { calls, measured: stats(entry) };
    };
    let { calls, measured } = await measure();
    for (let attempt = 1; attempt < 3 && calls <= measured.n * 10; attempt++) {
      ({ calls, measured } = await measure());
    }

    assert.true(
      measured.n >= TIMING.minSamples,
      `at least ${TIMING.minSamples} samples (${measured.n})`,
    );
    assert.true(
      calls > measured.n * 10,
      `many iterations a sample (${calls} calls, ${measured.n} samples)`,
    );
    assert.true(
      measured.min <= measured.p75 &&
        measured.p75 <= measured.p99 &&
        measured.p99 <= measured.p995 &&
        measured.p995 <= measured.p999 &&
        measured.p999 <= measured.max,
      'percentiles in order',
    );
    assert.true(measured.min <= measured.avg && measured.avg <= measured.max);
    assert.true(
      measured.avg > 0 && measured.avg < 1e6,
      `a time per iteration in ns (${measured.avg})`,
    );
    assert.deepEqual([measured.highPrecision, measured.usedExplicitTimers], [true, false]);
  });

  test('n is exactly that many iterations, each its own sample; warmup exactly that many before', async (assert) => {
    const { bench, run } = harness();
    let calls = 0;
    bench('counted', { n: 7, warmup: 3 }, () => void calls++);
    const [entry] = (await run({})).benches;

    assert.equal(stats(entry).n, 7);
    assert.equal(
      calls,
      1 + 3 + 7,
      'the first call, which tells sync from async, then warmup, then n',
    );
  });

  test('an async bench is awaited: its time is the promise’s', async (assert) => {
    const { bench, run } = harness();
    bench('waits', { n: 3, warmup: 0 }, () => new Promise((resolve) => setTimeout(resolve, 5)));
    const [entry] = (await run({})).benches;

    assert.true(stats(entry).min >= 4e6, `at least the 5ms it waits (${stats(entry).min}ns)`);
  });

  test('start() and end() time part of an iteration; under 10µs they are ignored, as deno bench ignores them', async (assert) => {
    const { bench, run } = harness();
    bench('slow part', (b) => {
      for (const until = performance.now() + 0.05; performance.now() < until;);
      b.start();
      for (const end = performance.now() + 0.02; performance.now() < end;);
      b.end();
    });
    bench('tiny part', (b) => {
      const list = [3, 1, 2];
      b.start();
      list.sort();
      b.end();
    });
    const [slow, tiny] = (await run({})).benches;

    assert.true(stats(slow).usedExplicitTimers);
    // The fastest iteration: load on the machine can only make one slower.
    assert.true(
      stats(slow).min >= 20_000 && stats(slow).min < 50_000,
      `only the 20µs between start() and end(), not the 50µs before (${stats(slow).min}ns)`,
    );
    assert.true(stats(tiny).usedExplicitTimers);
    assert.true(stats(tiny).n >= TIMING.minSamples);
  });

  test('a bench that throws, or misuses start() and end(), fails alone with its error; hooks hear of each', async (assert) => {
    const { bench, run } = harness();
    const heard: string[] = [];
    bench('throws', () => {
      throw new RangeError('boom');
    });
    bench('no end', (b) => b.start());
    bench('fine', () => {});
    const { benches } = await run({
      hooks: {
        started: (name) => void heard.push(`start ${name}`),
        finished: (entry) => void heard.push(`end ${entry.name}`),
      },
    });

    assert.deepEqual(
      benches.map((entry) =>
        'failed' in entry.results[0]
          ? [entry.results[0].failed.name, entry.results[0].failed.message]
          : 'ok',
      ),
      [['RangeError', 'boom'], ['Error', 'bench: start() was called without end()'], 'ok'],
    );
    assert.includes(
      (benches[0].results[0] as { failed: { stack: string } }).failed.stack,
      'RangeError: boom',
    );
    assert.deepEqual(heard, [
      'start throws',
      'end throws',
      'start no end',
      'end no end',
      'start fine',
      'end fine',
    ]);
  });
});
