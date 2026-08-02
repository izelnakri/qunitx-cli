import fs from 'node:fs/promises';
import { Task } from '../../task/index.ts';
import { readJsonCache } from '../../utils/read-json-cache.ts';

// Per-file wall-clock timings: the cache that feeds LPT group packing, and the reporting of it.

/**
 * Reads `tmp/test-timings.json` from projectRoot; returns `{}` on any error or invalid content.
 *
 * ```ts
 * import * as Timings from './timings.ts';
 *
 * await Timings.read('/no/such/project'); // {} — a missing or invalid cache degrades to empty
 * ```
 */
export function read(projectRoot: string): Task<Record<string, number>, never> {
  return readJsonCache(`${projectRoot}/tmp/test-timings.json`, isFileTimings).map(
    (timings) => timings ?? {},
  );
}

/** A cache written by this version: a plain map of file path to milliseconds. */
function isFileTimings(parsed: unknown): parsed is Record<string, number> {
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

/**
 * Distributes each group's wall-clock ms to its files proportionally by LPT weight.
 *
 * ```ts
 * import * as Timings from './timings.ts';
 *
 * const weights = new Map([['/a.ts', 300], ['/b.ts', 100]]);
 * const times = Timings.compute([['/a.ts', '/b.ts']], weights, new Map([[0, 800]]));
 * times.get('/a.ts'); // 600 — group 0's 800ms split 3:1 by weight
 * ```
 */
export function compute(
  groups: string[][],
  weights: Map<string, number>,
  wallTimes: Map<number, number>,
): Map<string, number> {
  return new Map(
    groups.flatMap((group, i): [string, number][] => {
      const wallMs = wallTimes.get(i);
      if (wallMs === undefined) return [];
      const total = group.reduce((sum, f) => sum + (weights.get(f) ?? 0), 0);
      return group.map((f) => [
        f,
        total > 0 ? wallMs * ((weights.get(f) ?? 0) / total) : wallMs / group.length,
      ]);
    }),
  );
}

/**
 * Writes the merged per-file timings back to `tmp/test-timings.json` for the next run to pack with.
 *
 * ```ts
 * import * as Timings from './timings.ts';
 *
 * // Defined, not invoked: writes tmp/test-timings.json under projectRoot.
 * async function saveTimings(fileTimes: Map<string, number>) {
 *   await Timings.persist(fileTimes, '/proj'); // next run's splitIntoGroups packs with these
 * }
 * ```
 */
export async function persist(fileTimes: Map<string, number>, projectRoot: string): Promise<void> {
  await fs.writeFile(
    `${projectRoot}/tmp/test-timings.json`,
    JSON.stringify(Object.fromEntries(fileTimes), null, 2),
  );
}

/**
 * `--debug` listing of this run's per-file wall times, slowest first.
 *
 * ```ts
 * import * as Timings from './timings.ts';
 *
 * Timings.print(new Map(), '/proj'); // empty run — prints nothing
 * // A non-empty map writes lines like `#   1240ms  test/cart-test.ts` to stdout.
 * ```
 */
export function print(fileTimes: Map<string, number>, projectRoot: string): void {
  if (fileTimes.size === 0) return;
  const lines = [...fileTimes.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([f, ms]) => `#   ${ms.toFixed(0)}ms  ${f.replace(`${projectRoot}/`, '')}`);
  process.stdout.write(`# File execution times:\n${lines.join('\n')}\n`);
}
