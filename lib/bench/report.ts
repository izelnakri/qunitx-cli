// How a run's results are shown: `deno bench`'s table, its JSON exactly, Markdown for a pull
// request or a GitHub job summary, and CSV for a spreadsheet or a script.
import type { BenchEntry, BenchStats } from './harness.ts';
import type { Comparison } from './compare.ts';
import { colorEnabled } from '../utils/color.ts';

/**
 * A whole run, as `deno bench --json` writes one: what ran it and every bench's outcome.
 *
 * ```ts
 * const report: BenchReport = { version: 1, runtime: 'Chromium/140.0 x64-linux', cpu: 'Intel Core', benches: [] };
 * ```
 */
export interface BenchReport {
  /** The JSON's version: Deno's is 1. */
  version: 1;
  /** The engine and its version, and the platform. */
  runtime: string;
  /** The CPU's model. */
  cpu: string;
  /** Every bench, file by file. */
  benches: BenchEntry[];
}

/**
 * The formats a run is reported in: `pretty` (`deno bench`'s table), `json` (`deno bench --json`),
 * `markdown` and `csv`.
 *
 * ```ts
 * const format: BenchFormat = 'markdown';
 * ```
 */
export type BenchFormat = 'pretty' | 'json' | 'markdown' | 'csv';

/**
 * Every format, in the order the help lists them.
 *
 * ```ts
 * import { BENCH_FORMATS } from './report.ts';
 *
 * BENCH_FORMATS; // ['pretty', 'json', 'markdown', 'csv']
 * ```
 */
export const BENCH_FORMATS: readonly BenchFormat[] = ['pretty', 'json', 'markdown', 'csv'];

/**
 * A time in nanoseconds as `deno bench` writes it: one decimal, in ps, ns, µs, ms or s.
 *
 * ```ts
 * import { duration } from './report.ts';
 *
 * [duration(0.7235), duration(200.1), duration(2_500), duration(1_234_567), duration(3e9)];
 * // ['723.5 ps', '200.1 ns', '2.5 µs', '1.2 ms', '3.0 s']
 * ```
 */
export function duration(nanoseconds: number): string {
  const units: [number, string][] = [
    [1e9, 's'],
    [1e6, 'ms'],
    [1e3, 'µs'],
    [1, 'ns'],
  ];
  for (const [size, unit] of units) {
    if (nanoseconds >= size) return `${(nanoseconds / size).toFixed(1)} ${unit}`;
  }
  return `${(nanoseconds * 1e3).toFixed(1)} ps`;
}

/**
 * Iterations a second for a mean time in nanoseconds, to four significant digits with thousands
 * separated, as `deno bench` writes it.
 *
 * ```ts
 * import { perSecond } from './report.ts';
 *
 * [perSecond(200.1), perSecond(6.8), perSecond(2.5e6), perSecond(3e9)]; // ['4,998,000', '147,100,000', '400', '0.3']
 * ```
 */
export function perSecond(nanoseconds: number): string {
  const rate = 1e9 / nanoseconds;
  if (!Number.isFinite(rate)) return '∞';
  if (rate < 10) return rate.toFixed(1);
  const digits = Math.max(0, Math.floor(Math.log10(rate)) - 3);
  return (Math.round(rate / 10 ** digits) * 10 ** digits).toLocaleString('en-US');
}

/**
 * A run's results as `format` asks, with each bench's change from `comparison`'s baseline when
 * there is one. `pretty` is `deno bench`'s table, colored when the terminal takes color; `json`
 * is exactly `deno bench --json`.
 *
 * ```ts
 * import { render } from './report.ts';
 *
 * render({ version: 1, runtime: 'Chromium/140', cpu: 'Intel', benches: [] }, 'json', null).includes('"version": 1'); // true
 * ```
 */
export function render(
  report: BenchReport,
  format: BenchFormat,
  comparison: Comparison | null,
  color = colorEnabled,
): string {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  if (format === 'csv') return csv(report, comparison);
  if (format === 'markdown') return markdown(report, comparison);
  return [
    header(report, color),
    ...files(report).map((file) => pretty(file, comparison, color)),
  ].join('\n');
}

/**
 * The run's two header lines, as `deno bench` prints them before any file.
 *
 * ```ts
 * import { header } from './report.ts';
 *
 * header({ version: 1, runtime: 'Firefox/146.0', cpu: 'Apple M3', benches: [] }, false);
 * // '    CPU | Apple M3\nRuntime | Firefox/146.0\n'
 * ```
 */
export function header(report: BenchReport, color = colorEnabled): string {
  const gray = paint(color, 38, 5, 245);
  return `${gray(`    CPU | ${report.cpu}`)}\n${gray(`Runtime | ${report.runtime}`)}\n`;
}

/**
 * One file's results as `deno bench` prints them: the file, a table of its ungrouped benches, then
 * each group's with its summary — how much faster or slower each is than the group's baseline, or
 * its fastest. A failed bench is its error, in place of its row.
 *
 * ```ts
 * import { pretty } from './report.ts';
 *
 * pretty({ origin: 'file:///a.bench.ts', benches: [] }, null, false); // '\nfile:///a.bench.ts\n\n'
 * ```
 */
export function pretty(
  file: { origin: string; benches: BenchEntry[] },
  comparison: Comparison | null,
  color = colorEnabled,
): string {
  const gray = paint(color, 38, 5, 245);
  const width = Math.max(9, ...file.benches.map((bench) => bench.name.length));
  const compared = Boolean(comparison);
  const lines = ['', gray(file.origin), ''];
  if (!file.benches.length) return `${lines.join('\n')}\n`;
  const columns = [
    pad('benchmark', width, 'left'),
    'time/iter (avg)',
    '       iter/s',
    '     (min … max)     ',
    '     p75',
    '     p99',
    '    p995',
    ...(compared ? ['   vs base'] : []),
  ];
  lines.push(`| ${columns.join(' | ')} |`);
  lines.push(`| ${columns.map((column) => '-'.repeat(column.length)).join(' | ')} |`);
  for (const [group, benches] of grouped(file.benches)) {
    if (group !== null) lines.push('', `${gray('group')} ${paint(color, 32)(group)}`);
    for (const bench of benches) lines.push(row(bench, width, comparison, color));
    if (group !== null) lines.push(...summary(benches, color));
  }
  return `${lines.join('\n')}\n`;
}

// A bench's row, or its error.
function row(
  bench: BenchEntry,
  width: number,
  comparison: Comparison | null,
  color: boolean,
): string {
  const result = bench.results[0];
  if ('failed' in result) {
    return `${pad(bench.name, width, 'left')}   ${paint(color, 31)('error')}: ${result.failed.stack}`;
  }
  const stats = result.ok;
  const [yellow, cyan, magenta] = [paint(color, 33), paint(color, 36), paint(color, 35)];
  const cells = [
    pad(bench.name, width, 'left'),
    yellow(pad(duration(stats.avg), 15)),
    pad(perSecond(stats.avg), 13),
    `(${cyan(pad(duration(stats.min), 8))} … ${magenta(pad(duration(stats.max), 8))})`,
    magenta(pad(duration(stats.p75), 8)),
    magenta(pad(duration(stats.p99), 8)),
    magenta(pad(duration(stats.p995), 8)),
  ];
  const change = changeOf(comparison, bench);
  if (comparison) cells.push(change ? changeText(change, color) : pad('new', 10));
  return `| ${cells.join(' | ')} |`;
}

// Padded before it is colored, so the escape codes never count toward its width.
function changeText(change: Comparison['changes'][number], color: boolean): string {
  const text = pad(`${change.percent >= 0 ? '+' : ''}${change.percent.toFixed(1)}%`, 10);
  if (change.regressed) return paint(color, 31)(text);
  return change.percent <= -change.threshold ? paint(color, 32)(text) : text;
}

// How each bench of a group compares with its baseline, or with its fastest.
function summary(benches: BenchEntry[], color: boolean): string[] {
  const measured = benches.flatMap((bench) =>
    'ok' in bench.results[0]
      ? [{ name: bench.name, baseline: bench.baseline, stats: bench.results[0].ok }]
      : [],
  );
  if (measured.length < 2) return [];
  const reference =
    measured.find((bench) => bench.baseline) ??
    measured.reduce((fastest, bench) => (bench.stats.avg < fastest.stats.avg ? bench : fastest));
  const name = (text: string) => paint(color, 1)(paint(color, 36)(text));
  const lines = ['', paint(color, 38, 5, 245)('summary'), `  ${name(reference.name)}`];
  for (const other of measured) {
    if (other === reference) continue;
    const faster = reference.stats.avg <= other.stats.avg;
    const ratio = faster
      ? other.stats.avg / reference.stats.avg
      : reference.stats.avg / other.stats.avg;
    lines.push(
      `     ${paint(color, faster ? 32 : 31)(ratio.toFixed(2))}x ${faster ? 'faster' : 'slower'} than ${name(other.name)}`,
    );
  }
  return lines;
}

function markdown(report: BenchReport, comparison: Comparison | null): string {
  const lines = [`**CPU** ${report.cpu} · **Runtime** ${report.runtime}`, ''];
  for (const file of files(report)) {
    lines.push(`### \`${file.origin.replace(/^file:\/\/\//, '/')}\``, '');
    for (const [group, benches] of grouped(file.benches)) {
      if (group !== null) lines.push(`**${group}**`, '');
      lines.push(
        `| benchmark | time/iter (avg) | iter/s | min … max | p75 | p99 | p995 |${comparison ? ' vs base |' : ''}`,
        `| --- | ---: | ---: | ---: | ---: | ---: | ---: |${comparison ? ' ---: |' : ''}`,
      );
      for (const bench of benches) {
        const result = bench.results[0];
        const name = bench.name.replace(/\|/g, '\\|');
        if ('failed' in result) {
          lines.push(`| ${name} | ❌ ${result.failed.message.replace(/\|/g, '\\|')} |`);
          continue;
        }
        const stats = result.ok;
        const change = changeOf(comparison, bench);
        const versus = change
          ? ` ${change.regressed ? '🔴 ' : ''}${change.percent >= 0 ? '+' : ''}${change.percent.toFixed(1)}% |`
          : comparison
            ? ' new |'
            : '';
        lines.push(
          `| ${name}${bench.baseline ? ' (baseline)' : ''} | ${duration(stats.avg)} | ${perSecond(stats.avg)} | ${duration(stats.min)} … ${duration(stats.max)} | ${duration(stats.p75)} | ${duration(stats.p99)} | ${duration(stats.p995)} |${versus}`,
        );
      }
      const summarized = group === null ? [] : summary(benches, false).slice(2);
      if (summarized.length)
        lines.push(
          '',
          ...summarized
            .map((line) => line.trim())
            .map((line, index) => (index ? `- ${line}` : `${line}:`)),
        );
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

function csv(report: BenchReport, comparison: Comparison | null): string {
  const field = (value: string | number | boolean | null) => {
    const text = value === null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const head = [
    'file',
    'group',
    'name',
    'baseline',
    'n',
    'avg_ns',
    'min_ns',
    'max_ns',
    'p75_ns',
    'p99_ns',
    'p995_ns',
    'p999_ns',
    'iter_per_s',
    'error',
    ...(comparison ? ['base_avg_ns', 'change_percent', 'regressed'] : []),
  ];
  const rows = report.benches.map((bench) => {
    const result = bench.results[0];
    const stats: Partial<BenchStats> = 'ok' in result ? result.ok : {};
    const change = changeOf(comparison, bench);
    return [
      bench.origin,
      bench.group,
      bench.name,
      bench.baseline,
      stats.n ?? null,
      stats.avg ?? null,
      stats.min ?? null,
      stats.max ?? null,
      stats.p75 ?? null,
      stats.p99 ?? null,
      stats.p995 ?? null,
      stats.p999 ?? null,
      stats.avg ? Math.round(1e9 / stats.avg) : null,
      'failed' in result ? result.failed.message : null,
      ...(comparison
        ? [
            change?.base ?? null,
            change ? +change.percent.toFixed(2) : null,
            change?.regressed ?? null,
          ]
        : []),
    ];
  });
  return `${[head, ...rows].map((row) => row.map(field).join(',')).join('\n')}\n`;
}

/**
 * A run's benches, file by file in the order they ran.
 *
 * ```ts
 * import { files } from './report.ts';
 *
 * files({ version: 1, runtime: '', cpu: '', benches: [] }); // []
 * ```
 */
export function files(report: BenchReport): { origin: string; benches: BenchEntry[] }[] {
  const byOrigin = new Map<string, BenchEntry[]>();
  for (const bench of report.benches) {
    byOrigin.set(bench.origin, [...(byOrigin.get(bench.origin) ?? []), bench]);
  }
  return [...byOrigin].map(([origin, benches]) => ({ origin, benches }));
}

// A bench's change in `comparison`, matched by file, group and name rather than by identity, so
// a comparison made from one copy of a report describes another.
function changeOf(
  comparison: Comparison | null,
  bench: BenchEntry,
): Comparison['changes'][number] | undefined {
  return comparison?.changes.find(
    (change) =>
      change.bench.origin === bench.origin &&
      change.bench.group === bench.group &&
      change.bench.name === bench.name,
  );
}

// Ungrouped first, then each group in the order it first appears.
function grouped(benches: BenchEntry[]): [string | null, BenchEntry[]][] {
  const groups = new Map<string | null, BenchEntry[]>([[null, []]]);
  for (const bench of benches) groups.set(bench.group, [...(groups.get(bench.group) ?? []), bench]);
  return [...groups].filter(([, members]) => members.length);
}

function pad(text: string, width: number, side: 'left' | 'right' = 'right'): string {
  const room = ' '.repeat(Math.max(0, width - text.length));
  return side === 'left' ? text + room : room + text;
}

function paint(enabled: boolean, ...codes: number[]): (text: string) => string {
  const close = codes[0] === 1 ? 22 : 39;
  return (text) => (enabled ? `\x1b[${codes.join(';')}m${text}\x1b[${close}m` : text);
}
