// A run against a baseline: each bench's change in mean time, and which changes count as
// regressions — far enough over the threshold, and by enough time, not to be noise.
import type { BenchEntry } from './harness.ts';
import type { BenchReport } from './report.ts';

/**
 * A bench's mean time in a baseline, found by its file, group and name.
 *
 * ```ts
 * const entry: BaselineEntry = { origin: 'benches/url.bench.ts', group: null, name: 'parse', avg: 210.4 };
 * ```
 */
export interface BaselineEntry {
  /** Its file, relative to the project, or null when the baseline did not say. */
  origin: string | null;
  /** Its group, or null. */
  group: string | null;
  /** Its name. */
  name: string;
  /** Its mean time per iteration, in nanoseconds. */
  avg: number;
}

/**
 * When a slower bench is a regression: slower by more than `threshold` percent AND by more than
 * `minDelta` nanoseconds, so a nanosecond bench's jitter never fails a run.
 *
 * ```ts
 * const rule: RegressionRule = { threshold: 10, minDelta: 1_000 };
 * ```
 */
export interface RegressionRule {
  /** Percent slower that fails. */
  threshold: number;
  /** Nanoseconds slower that fails, at the least. */
  minDelta: number;
}

/**
 * A run compared with a baseline: each measured bench the baseline has, how its mean changed, and
 * whether that is a regression; and the benches the baseline has that did not run.
 *
 * ```ts
 * const comparison: Comparison = { changes: [], missing: [], regressions: [] };
 * ```
 */
export interface Comparison {
  /** Each bench found in the baseline: its outcome, its baseline mean and the change. */
  changes: {
    bench: BenchEntry;
    base: number;
    percent: number;
    regressed: boolean;
    threshold: number;
  }[];
  /** Baseline benches not in this run. */
  missing: BaselineEntry[];
  /** The changes that are regressions. */
  regressions: Comparison['changes'];
}

/**
 * The benches of a baseline file: `deno bench --json` or `qunitx bench --json` output (either may
 * be from `deno bench` itself), or a `{ results: { name: avg } }` map as the hand-rolled
 * checkers save. Origins are made relative to `root`, so a baseline from another checkout matches.
 *
 * ```ts
 * import { readBaseline } from './compare.ts';
 *
 * readBaseline({ results: { parse: 210 } }, '/project'); // [{ origin: null, group: null, name: 'parse', avg: 210 }]
 * ```
 */
export function readBaseline(json: unknown, root: string): BaselineEntry[] {
  const value = json as { benches?: BenchEntry[]; results?: Record<string, number> };
  if (Array.isArray(value?.benches)) {
    return value.benches.flatMap((bench) => {
      const result = bench.results?.[0];
      return result && 'ok' in result
        ? [
            {
              origin: relative(bench.origin, root),
              group: bench.group ?? null,
              name: bench.name,
              avg: result.ok.avg,
            },
          ]
        : [];
    });
  }
  if (value?.results && typeof value.results === 'object') {
    return Object.entries(value.results).flatMap(([name, avg]) =>
      typeof avg === 'number' ? [{ origin: null, group: null, name, avg }] : [],
    );
  }
  throw new TypeError('not a benchmark baseline: expected `deno bench --json` output');
}

/**
 * Compares `report` with `baseline` under `rule`. A bench is matched by file, group and name;
 * failing that, by group and name; failing that, by its name alone when only one bench has it.
 * The threshold grows for the fastest benches, whose run-to-run noise is the largest: twice it
 * under a microsecond.
 *
 * ```ts
 * import { compare } from './compare.ts';
 *
 * const bench = { origin: 'file:///p/a.bench.ts', group: null, name: 'parse', baseline: false,
 *   results: [{ ok: { n: 1, min: 1, max: 1, avg: 3_000, p75: 1, p99: 1, p995: 1, p999: 1, highPrecision: true, usedExplicitTimers: false } }] };
 * const result = compare({ version: 1, runtime: '', cpu: '', benches: [bench] }, [{ origin: 'a.bench.ts', group: null, name: 'parse', avg: 2_000 }], { threshold: 10, minDelta: 500 }, '/p');
 * [result.changes[0].percent, result.regressions.length]; // [50, 1]
 * ```
 */
export function compare(
  report: BenchReport,
  baseline: BaselineEntry[],
  rule: RegressionRule,
  root: string,
): Comparison {
  // Each measured bench with a base to compare against: its change, and the entry it was compared
  // with.
  const matched = report.benches.flatMap((bench) => {
    const result = bench.results[0];
    if (!('ok' in result)) return [];
    const origin = relative(bench.origin, root);
    const named = baseline.filter((entry) => entry.name === bench.name);
    const base =
      named.find((entry) => entry.origin === origin && entry.group === bench.group) ??
      named.find((entry) => entry.origin === null && entry.group === bench.group) ??
      (named.length === 1 ? named[0] : undefined);
    if (!base || base.avg <= 0) return [];

    const percent = ((result.ok.avg - base.avg) / base.avg) * 100;
    const threshold = rule.threshold * (base.avg < 1_000 ? 2 : 1);
    const regressed = percent > threshold && result.ok.avg - base.avg > rule.minDelta;
    return [{ entry: base, change: { bench, base: base.avg, percent, threshold, regressed } }];
  });
  const changes = matched.map(({ change }) => change);
  const used = new Set(matched.map(({ entry }) => entry));
  return {
    changes,
    missing: baseline.filter((entry) => !used.has(entry)),
    regressions: changes.filter((change) => change.regressed),
  };
}

/**
 * `report` with each bench measured again in `retry` given its better mean: the faster of the two
 * runs, as the least disturbed measurement of the same code.
 *
 * ```ts
 * import { fastestOf } from './compare.ts';
 *
 * fastestOf({ version: 1, runtime: '', cpu: '', benches: [] }, []).benches; // []
 * ```
 */
export function fastestOf(report: BenchReport, retry: BenchEntry[]): BenchReport {
  return {
    ...report,
    benches: report.benches.map((bench) => {
      const again = retry.find(
        (other) =>
          other.origin === bench.origin && other.group === bench.group && other.name === bench.name,
      );
      const [first, second] = [bench.results[0], again?.results[0]];
      if (!second || !('ok' in second)) return bench;
      if ('ok' in first && first.ok.avg <= second.ok.avg) return bench;
      return again!;
    }),
  };
}

/**
 * A regular expression matching exactly these names, for the filter that runs only them again.
 *
 * ```ts
 * import { exactly } from './compare.ts';
 *
 * exactly(['a (b)', 'c']); // '/^(?:a \\(b\\)|c)$/'
 * ```
 */
export function exactly(names: string[]): string {
  return `/^(?:${names.map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})$/`;
}

// A bench's file relative to the project, so baselines from another checkout or machine match.
function relative(origin: string, root: string): string {
  const prefix = `file://${root.startsWith('/') ? '' : '/'}${root.replace(/\\/g, '/')}/`;
  return origin.startsWith(prefix) ? origin.slice(prefix.length) : origin;
}
