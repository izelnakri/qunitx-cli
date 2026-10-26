import { module, test } from 'qunitx';
import {
  duration,
  header,
  perSecond,
  pretty,
  render,
  type BenchReport,
} from '../../lib/bench/report.ts';
import { compare, exactly, fastestOf, readBaseline } from '../../lib/bench/compare.ts';
import type { BenchEntry } from '../../lib/bench/harness.ts';
import '../helpers/custom-asserts.ts';

const ok = (avg: number, extra: Partial<Record<string, number>> = {}) => ({
  ok: {
    n: 10,
    min: avg * 0.9,
    max: avg * 1.5,
    avg,
    p75: avg * 1.1,
    p99: avg * 1.4,
    p995: avg * 1.45,
    p999: avg * 1.5,
    highPrecision: true,
    usedExplicitTimers: false,
    ...extra,
  },
});
const entry = (
  name: string,
  avg: number | null,
  group: string | null = null,
  baseline = false,
): BenchEntry => ({
  origin: 'file:///p/benches/a.bench.ts',
  group,
  name,
  baseline,
  results: [
    avg === null
      ? { failed: { name: 'Error', message: 'boom', stack: 'Error: boom\n    at a.bench.ts:3:9' } }
      : ok(avg),
  ],
});
const REPORT: BenchReport = {
  version: 1,
  runtime: 'Chromium/145.0 x64-linux',
  cpu: 'Test CPU',
  benches: [
    entry('parse', 200.1),
    entry('throws', null),
    entry('slice', 30, 'arr', true),
    entry('spread', 15, 'arr'),
    entry('concat', 60, 'arr'),
  ],
};

module('Bench | report | numbers', { concurrency: true }, () => {
  test('times and rates as deno bench writes them', (assert) => {
    assert.deepEqual([0.7235, 200.1, 2_500, 1_234_567, 3e9].map(duration), [
      '723.5 ps',
      '200.1 ns',
      '2.5 µs',
      '1.2 ms',
      '3.0 s',
    ]);
    assert.deepEqual([200.1, 6.8, 2.5e6, 3e9].map(perSecond), [
      '4,998,000',
      '147,100,000',
      '400',
      '0.3',
    ]);
  });
});

module('Bench | report | formats', { concurrency: true }, () => {
  test("pretty is deno bench's table: ungrouped, then each group with its summary, errors in place", (assert) => {
    assert.equal(header(REPORT, false), '    CPU | Test CPU\nRuntime | Chromium/145.0 x64-linux\n');
    assert.equal(
      pretty({ origin: REPORT.benches[0].origin, benches: REPORT.benches }, null, false),
      [
        '',
        'file:///p/benches/a.bench.ts',
        '',
        '| benchmark | time/iter (avg) |        iter/s |      (min … max)      |      p75 |      p99 |     p995 |',
        '| --------- | --------------- | ------------- | --------------------- | -------- | -------- | -------- |',
        '| parse     |        200.1 ns |     4,998,000 | (180.1 ns … 300.1 ns) | 220.1 ns | 280.1 ns | 290.1 ns |',
        'throws      error: Error: boom\n    at a.bench.ts:3:9',
        '',
        'group arr',
        '| slice     |         30.0 ns |    33,330,000 | ( 27.0 ns …  45.0 ns) |  33.0 ns |  42.0 ns |  43.5 ns |',
        '| spread    |         15.0 ns |    66,670,000 | ( 13.5 ns …  22.5 ns) |  16.5 ns |  21.0 ns |  21.8 ns |',
        '| concat    |         60.0 ns |    16,670,000 | ( 54.0 ns …  90.0 ns) |  66.0 ns |  84.0 ns |  87.0 ns |',
        '',
        'summary',
        '  slice',
        '     2.00x slower than spread',
        '     2.00x faster than concat',
        '',
      ].join('\n'),
    );
  });

  test('without a baseline a group is summed up against its fastest; one bench has no summary', (assert) => {
    const fastest = pretty(
      { origin: 'file:///a', benches: [entry('a', 10, 'g'), entry('b', 40, 'g')] },
      null,
      false,
    );
    const alone = pretty({ origin: 'file:///a', benches: [entry('a', 10, 'g')] }, null, false);

    assert.includes(fastest, 'summary\n  a\n     4.00x faster than b');
    assert.notIncludes(alone, 'summary');
  });

  test("json is deno bench --json's, byte for byte in shape", (assert) => {
    const json = JSON.parse(render(REPORT, 'json', null));

    assert.deepEqual(Object.keys(json), ['version', 'runtime', 'cpu', 'benches']);
    assert.deepEqual(Object.keys(json.benches[0]), [
      'origin',
      'group',
      'name',
      'baseline',
      'results',
    ]);
    assert.deepEqual(Object.keys(json.benches[0].results[0].ok), [
      'n',
      'min',
      'max',
      'avg',
      'p75',
      'p99',
      'p995',
      'p999',
      'highPrecision',
      'usedExplicitTimers',
    ]);
    assert.deepEqual(json.benches[1].results[0].failed, {
      name: 'Error',
      message: 'boom',
      stack: 'Error: boom\n    at a.bench.ts:3:9',
    });
  });

  test('markdown has a table a group, the baseline marked, errors and the change from a baseline', (assert) => {
    const comparison = compare(
      REPORT,
      [{ origin: 'benches/a.bench.ts', group: null, name: 'parse', avg: 100 }],
      { threshold: 10, minDelta: 0 },
      '/p',
    );
    const text = render(REPORT, 'markdown', comparison);

    assert.includes(text, '**CPU** Test CPU · **Runtime** Chromium/145.0 x64-linux');
    assert.includes(text, '### `/p/benches/a.bench.ts`');
    assert.includes(
      text,
      '| parse | 200.1 ns | 4,998,000 | 180.1 ns … 300.1 ns | 220.1 ns | 280.1 ns | 290.1 ns | 🔴 +100.1% |',
    );
    assert.includes(text, '| throws | ❌ boom |');
    assert.includes(text, '| slice (baseline) | 30.0 ns |');
    assert.includes(text, '| new |', 'a bench the baseline does not have');
    assert.includes(text, 'slice:\n- 2.00x slower than spread\n- 2.00x faster than concat');
  });

  test('csv is a row a bench, quoted where it must be, with the change when compared', (assert) => {
    const quoted: BenchReport = { ...REPORT, benches: [entry('a, "b"', 100)] };
    const comparison = compare(
      quoted,
      [{ origin: null, group: null, name: 'a, "b"', avg: 50 }],
      { threshold: 10, minDelta: 0 },
      '/p',
    );
    const [head, row] = render(quoted, 'csv', comparison).trim().split('\n');

    assert.equal(
      head,
      'file,group,name,baseline,n,avg_ns,min_ns,max_ns,p75_ns,p99_ns,p995_ns,p999_ns,iter_per_s,error,base_avg_ns,change_percent,regressed',
    );
    assert.equal(
      row,
      'file:///p/benches/a.bench.ts,,"a, ""b""",false,10,100,90,150,110.00000000000001,140,145,150,10000000,,50,100,true',
    );
  });
});

module('Bench | compare', { concurrency: true }, () => {
  test('a baseline is deno bench --json, qunitx bench --json, or a name → mean map; anything else is refused', (assert) => {
    assert.deepEqual(
      readBaseline({ ...REPORT }, '/p').map((base) => [
        base.origin,
        base.group,
        base.name,
        base.avg,
      ]),
      [
        ['benches/a.bench.ts', null, 'parse', 200.1],
        ['benches/a.bench.ts', 'arr', 'slice', 30],
        ['benches/a.bench.ts', 'arr', 'spread', 15],
        ['benches/a.bench.ts', 'arr', 'concat', 60],
      ],
      'failed benches have no mean to compare with',
    );
    assert.deepEqual(readBaseline({ savedAt: 'x', results: { parse: 100 } }, '/p'), [
      { origin: null, group: null, name: 'parse', avg: 100 },
    ]);
    assert.throws(() => readBaseline([1, 2], '/p'), /expected `deno bench --json` output/);
  });

  test('a regression is over the threshold AND the minimum delta; the threshold doubles under a microsecond', (assert) => {
    const run: BenchReport = {
      ...REPORT,
      benches: [entry('slow', 2_400), entry('jittery', 600), entry('tiny', 300)],
    };
    const result = compare(
      run,
      [
        { origin: 'benches/a.bench.ts', group: null, name: 'slow', avg: 2_000 },
        { origin: 'benches/a.bench.ts', group: null, name: 'jittery', avg: 500 },
        { origin: 'benches/a.bench.ts', group: null, name: 'tiny', avg: 100 },
        { origin: 'benches/gone.bench.ts', group: null, name: 'gone', avg: 1 },
      ],
      { threshold: 10, minDelta: 150 },
      '/p',
    );

    assert.deepEqual(
      result.changes.map((change) => [
        change.bench.name,
        Math.round(change.percent),
        change.threshold,
        change.regressed,
      ]),
      [
        ['slow', 20, 10, true],
        ['jittery', 20, 20, false],
        ['tiny', 200, 20, true],
      ],
    );
    assert.deepEqual(
      result.missing.map((base) => base.name),
      ['gone'],
    );
    assert.deepEqual(
      result.regressions.map((change) => change.bench.name),
      ['slow', 'tiny'],
    );
  });

  test('benches match by file, group and name, then group and name, then a name only one has', (assert) => {
    const run: BenchReport = { ...REPORT, benches: [entry('x', 100, 'g'), entry('y', 100)] };
    const result = compare(
      run,
      [
        { origin: 'benches/other.bench.ts', group: 'g', name: 'x', avg: 1 },
        { origin: 'benches/a.bench.ts', group: 'g', name: 'x', avg: 50 },
        { origin: null, group: 'h', name: 'y', avg: 25 },
      ],
      { threshold: 10, minDelta: 0 },
      '/p',
    );

    assert.deepEqual(
      result.changes.map((change) => [change.bench.name, change.base]),
      [
        ['x', 50],
        ['y', 25],
      ],
    );
  });

  test('a retry keeps each bench’s faster run; a filter of exact names is escaped', (assert) => {
    const merged = fastestOf({ ...REPORT, benches: [entry('a', 100), entry('b', 100)] }, [
      entry('a', 80),
      entry('b', 120),
    ]);

    assert.deepEqual(
      merged.benches.map((bench) => (bench.results[0] as { ok: { avg: number } }).ok.avg),
      [80, 100],
    );
    assert.equal(exactly(['render (100 rows)', 'a/b']), '/^(?:render \\(100 rows\\)|a\\/b)$/');
    assert.true(new RegExp('^(?:render \\(100 rows\\)|a\\/b)$').test('render (100 rows)'));
  });
});
