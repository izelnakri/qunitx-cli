import fs from 'node:fs/promises';

// Per-file wall-clock timings: the cache that feeds LPT group packing, and the reporting of it.

/** Reads `tmp/test-timings.json` from projectRoot; returns `{}` on any error or invalid content. */
export async function read(projectRoot: string): Promise<Record<string, number>> {
  try {
    const parsed = JSON.parse(await fs.readFile(`${projectRoot}/tmp/test-timings.json`, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Distributes each group's wall-clock ms to its files proportionally by LPT weight. */
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

/** Writes the merged per-file timings back to `tmp/test-timings.json` for the next run to pack with. */
export async function persist(fileTimes: Map<string, number>, projectRoot: string): Promise<void> {
  await fs.writeFile(
    `${projectRoot}/tmp/test-timings.json`,
    JSON.stringify(Object.fromEntries(fileTimes), null, 2),
  );
}

/** `--debug` listing of this run's per-file wall times, slowest first. */
export function print(fileTimes: Map<string, number>, projectRoot: string): void {
  if (fileTimes.size === 0) return;
  const lines = [...fileTimes.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([f, ms]) => `#   ${ms.toFixed(0)}ms  ${f.replace(`${projectRoot}/`, '')}`);
  process.stdout.write(`# File execution times:\n${lines.join('\n')}\n`);
}
