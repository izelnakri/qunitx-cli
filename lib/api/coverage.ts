import { buildRows } from '../coverage/report.ts';
import type { Config } from '../types.ts';
import type { CoverageSummary, FileCoverageSummary } from './types.ts';

/**
 * Turns the run's raw coverage map into the public summary. Built on the same `buildRows` the
 * terminal and lcov reports use, so the numbers an API consumer reads are identical to what
 * `--coverage` prints — including the exclusion of the test files themselves.
 */
export function summarizeCoverage(config: Config): CoverageSummary | undefined {
  const collector = config._coverageCollector;
  if (!collector) return undefined;

  const rows = buildRows(collector, new Set(Object.keys(config.fsTree)), config.projectRoot);
  const files: Record<string, FileCoverageSummary> = {};
  let totalLines = 0;
  let coveredLines = 0;

  for (const row of rows) {
    totalLines += row.total;
    coveredLines += row.covered;
    files[row.displayPath] = {
      totalLines: row.total,
      coveredLines: row.covered,
      percentage: row.pct,
      uncoveredLines: [...row.fileCoverage.coverable]
        .filter((line) => (row.fileCoverage.covered.get(line) ?? 0) === 0)
        .sort((a, b) => a - b),
    };
  }

  return {
    totalLines,
    coveredLines,
    // A run with nothing coverable is fully covered, not 0% — the same convention the
    // terminal summary uses for an empty report.
    percentage: totalLines > 0 ? (coveredLines / totalLines) * 100 : 100,
    files,
  };
}
