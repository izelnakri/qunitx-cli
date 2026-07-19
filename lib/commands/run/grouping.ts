import fs from 'node:fs/promises';
import path from 'node:path';
import { blue } from '../../utils/color.ts';
import { resolveLineTargets } from '../../selection/line-targets.ts';
import type { QUnitSelector } from '../../selection/line-targets.ts';
import type { Config } from '../../types.ts';

// How a run is divided into groups: which files are scoped by `file#34` targets, and how the
// rest are packed across the available cores.

/**
 * Watch-mode line targets: narrow fsTree to the targeted files and apply their selectors for the
 * whole session.
 *
 * Watch is one page with one QUnit config, so a page-global selector set would filter every OTHER
 * file's tests down to nothing on the next save — the per-file scoping concurrent mode gets from
 * one-group-per-file has nowhere to live here. Narrowing fsTree keeps the selectors true for
 * everything loaded, at the cost of dropping untargeted inputs; those are named rather than
 * silently watched-but-never-run. `qa` clears the selectors to run everything still watched.
 */
export async function applyWatchLineTargets(config: Config): Promise<void> {
  const allFiles = Object.keys(config.fsTree);
  const targets = await resolveTargetedFiles(config, allFiles);
  if (targets.length === 0) return;

  const targetedPaths = new Set(targets.map((target) => target.file));
  const dropped = allFiles.filter((file) => !targetedPaths.has(file));
  config.fsTree = Object.fromEntries([...targetedPaths].map((file) => [file, config.fsTree[file]]));
  config._qunitSelectors = targets.flatMap((target) => target.selectors);
  if (dropped.length > 0) {
    console.log(
      '#',
      blue(
        `qunitx: --watch with a line target runs only the targeted file${targetedPaths.size === 1 ? '' : 's'} — ${dropped.length} other file${dropped.length === 1 ? '' : 's'} excluded from this session`,
      ),
    );
  }
  console.log('#', blue(`qunitx: press "qa" to run every test in the watched file(s)`));
}

/** A file whose run is narrowed by `file#34` targets, with the selectors that scope it. */
interface TargetedFile {
  file: string;
  selectors: QUnitSelector[];
}

/**
 * Resolves each `file#34` input into the selectors for that file, dropping targets whose file is
 * no longer in the run (a glob, `--changed` or `--only-failed` may have filtered it out) and
 * those that resolved to nothing — both fall back to running the file whole, which is what a
 * null `selectors` means. Every warning is surfaced; a line target that quietly did not narrow
 * is worse than one that says so.
 */
export async function resolveTargetedFiles(
  config: Config,
  allFiles: string[],
): Promise<TargetedFile[]> {
  const present = new Set(allFiles);
  const entries = Object.entries(config.lineTargets ?? {}).filter(([file]) => present.has(file));
  const resolved = await Promise.all(
    entries.map(async ([file, lines]) => {
      const { selectors, warnings } = await resolveLineTargets(
        file,
        lines,
        // Forward slashes in the warning regardless of OS — it echoes the `path#line` the user
        // typed, and they typed '/'. path.relative yields '\' on Windows.
        path.relative(config.projectRoot, file).replaceAll('\\', '/'),
      );

      return { file, selectors, warnings };
    }),
  );
  // Logged after the parallel resolve so warnings print in input order, not resolution order.
  resolved.forEach((entry) => {
    entry.warnings.forEach((warning) => console.log('#', blue(`qunitx: ${warning}`)));
  });

  // Null selectors mean the target degraded to "run the whole file" — there is nothing to scope,
  // so it is not a targeted file and falls through to the untargeted pool.
  return resolved
    .filter((entry) => entry.selectors !== null)
    .map(({ file, selectors }) => ({ file, selectors: selectors! }));
}

// LPT (Longest Processing Time first) bin-packing: sort files by estimated time descending,
// then assign each to the group with the smallest current total. Uses cached per-file timings
// when available; falls back to file size scaled by msPerByte for unknown files.
/**
 * Packs files into `groupCount` groups of roughly equal estimated duration, returning the groups
 * and the per-file weights the estimate used (the caller reuses them to apportion wall time).
 */
export async function splitIntoGroups(
  files: string[],
  groupCount: number,
  timings: Record<string, number>,
): Promise<{ groups: string[][]; weights: Map<string, number> }> {
  const sizes = await Promise.all(
    files.map((f) =>
      timings[f] > 0
        ? Promise.resolve(0)
        : fs
            .stat(f)
            .then((s) => s.size)
            .catch(() => 0),
    ),
  );
  const knownRates = files
    .map((f, i) => ({ ms: timings[f], size: sizes[i] }))
    .filter(({ ms, size }) => ms > 0 && size > 0);
  const msPerByte =
    knownRates.length > 0
      ? knownRates.reduce((sum, { ms, size }) => sum + ms / size, 0) / knownRates.length
      : 1;
  const weights = new Map(
    files.map((f, i) => [f, timings[f] > 0 ? timings[f] : sizes[i] * msPerByte]),
  );
  const buckets = Array.from({ length: groupCount }, () => ({ files: [] as string[], total: 0 }));
  [...files]
    .sort((a, b) => (weights.get(b) ?? 0) - (weights.get(a) ?? 0))
    .forEach((f) => {
      const min = buckets.reduce((m, _, i) => (buckets[i].total < buckets[m].total ? i : m), 0);
      buckets[min].files.push(f);
      buckets[min].total += weights.get(f) ?? 0;
    });
  return { groups: buckets.filter((b) => b.files.length > 0).map((b) => b.files), weights };
}
