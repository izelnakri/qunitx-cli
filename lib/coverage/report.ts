import fs from 'node:fs/promises';
import path from 'node:path';
import { green, red, yellow } from '../utils/color.ts';
import type { Config, CoverageFileMap, FileCoverage } from '../types.ts';

/**
 * Renders the run's accumulated line coverage: an always-on terminal summary, plus the optional
 * `lcov.info` and self-contained `index.html` reports under `<output>/coverage/` when the user
 * requested them via `--coverage=lcov,html`. Test entry files are excluded from the report — the
 * bundle maps to them too, but coverage of the code under test is what users expect.
 */

// A coverage threshold below which a file's percentage is highlighted red; above the upper one
// it is green; between, yellow. Purely cosmetic (terminal + HTML), not a pass/fail gate.
const GOOD_PCT = 80;
const OK_PCT = 50;

interface FileRow {
  displayPath: string;
  total: number; // coverable (executable) lines
  covered: number; // coverable lines with hit count > 0
  pct: number;
  fileCoverage: FileCoverage;
}

// The optional on-disk formats `--coverage=` accepts, in the order their `# wrote` lines print.
// Adding a format is a row here plus a builder — never another branch in writeCoverageReport.
const ARTIFACTS = [
  { format: 'lcov', file: 'lcov.info', render: buildLcov },
  { format: 'html', file: 'index.html', render: buildHtml },
];

/**
 * Renders the run's accumulated coverage: always prints the terminal summary, then writes the
 * `lcov`/`html` reports the user requested via `config.coverageFormats`. `testFiles` (the run's
 * test entry paths) are excluded so the report reflects the code under test, not the tests.
 */
export async function writeCoverageReport(config: Config, testFiles: string[]): Promise<void> {
  const collector = config._coverageCollector;
  if (!collector || collector.size === 0) {
    process.stdout.write(
      '# Coverage: no coverable sources found (bundle mapped only to node_modules / test files)\n',
    );
    return;
  }

  const rows = buildRows(collector, new Set(testFiles), config.projectRoot);
  if (rows.length === 0) {
    process.stdout.write('# Coverage: no non-test sources found to report\n');
    return;
  }

  printTerminalSummary(rows);

  const formats = config.coverageFormats ?? [];
  if (formats.length === 0) return;

  const coverageDir = path.join(path.resolve(config.projectRoot, config.output), 'coverage');
  await fs.mkdir(coverageDir, { recursive: true });

  // Independent files, so write them concurrently. Each resolves to its own `# wrote` line,
  // emitted after the join in array order, so output stays deterministic no matter which
  // write settles first.
  const formatWrites = ARTIFACTS.filter(({ format }) => formats.includes(format)).map(
    async ({ format, file, render }) => {
      const filePath = path.join(coverageDir, file);
      await fs.writeFile(filePath, render(rows));
      return `# wrote coverage ${format} to ${toDisplayPath(filePath, config.projectRoot)}\n`;
    },
  );
  process.stdout.write((await Promise.all(formatWrites)).join(''));
}

export { writeCoverageReport as default };

/** Turns the raw coverage map into sorted, test-file-filtered rows with computed percentages. */
export function buildRows(
  collector: CoverageFileMap,
  testFiles: Set<string>,
  projectRoot: string,
): FileRow[] {
  // Compare on the project-relative POSIX path rather than the raw key. The two sides arrive
  // in different shapes — `testFiles` are OS paths from fsTree (backslashes on Windows), while
  // coverage keys come from the source map (always `/`). Without normalizing, `has()` never
  // matches on Windows and test files leak into the report.
  const excluded = new Set([...testFiles].map((file) => toDisplayPath(file, projectRoot)));

  // One pass: returning `[]` drops a file, returning the row keeps it. The early exit means
  // excluded and empty files never pay for the line count, same as the filter did.
  return [...collector]
    .flatMap(([absolutePath, fileCoverage]) => {
      const displayPath = toDisplayPath(absolutePath, projectRoot);
      const total = fileCoverage.coverable.size;
      if (excluded.has(displayPath) || total === 0) return [];

      const covered = [...fileCoverage.coverable].filter(
        (line) => (fileCoverage.covered.get(line) ?? 0) > 0,
      ).length;
      return { displayPath, total, covered, pct: (covered / total) * 100, fileCoverage };
    })
    .sort((a, b) => a.displayPath.localeCompare(b.displayPath));
}

function printTerminalSummary(rows: FileRow[]): void {
  const totalLines = rows.reduce((sum, row) => sum + row.total, 0);
  const coveredLines = rows.reduce((sum, row) => sum + row.covered, 0);
  const overallPct = totalLines > 0 ? (coveredLines / totalLines) * 100 : 0;

  const pathWidth = Math.min(
    60,
    Math.max(9, ...rows.map((row) => row.displayPath.length), 'All files'.length),
  );
  const divider = `# ${'-'.repeat(pathWidth + 20)}`;

  // Assemble, then write once. The table is one frame of output, and a concurrent group's TAP
  // interleaving between rows would tear it apart — a per-row write invites exactly that.
  process.stdout.write(
    [
      '#',
      '# Coverage (V8 line coverage)',
      divider,
      `# ${'File'.padEnd(pathWidth)}   ${'% Lines'.padStart(8)}   Lines`,
      divider,
      ...rows.map((row) => formatRow(row.displayPath, row.pct, row.covered, row.total, pathWidth)),
      divider,
      formatRow('All files', overallPct, coveredLines, totalLines, pathWidth),
      divider,
      '',
    ].join('\n'),
  );
}

function formatRow(
  label: string,
  pct: number,
  covered: number,
  total: number,
  pathWidth: number,
): string {
  const truncated = label.length > pathWidth ? `…${label.slice(-(pathWidth - 1))}` : label;
  const pctText = `${pct.toFixed(2)}%`.padStart(8);
  const colored = pct >= GOOD_PCT ? green(pctText) : pct >= OK_PCT ? yellow(pctText) : red(pctText);
  return `# ${truncated.padEnd(pathWidth)}   ${colored}   ${covered}/${total}`;
}

/** Builds a standard LCOV `lcov.info` string (line coverage only: DA/LF/LH per file). */
export function buildLcov(rows: FileRow[]): string {
  return (
    rows
      .map(({ displayPath, total, covered, fileCoverage }) =>
        [
          'TN:',
          `SF:${displayPath}`,
          ...[...fileCoverage.coverable]
            .sort((a, b) => a - b)
            .map((line) => `DA:${line},${fileCoverage.covered.get(line) ?? 0}`),
          `LF:${total}`,
          `LH:${covered}`,
          'end_of_record',
        ].join('\n'),
      )
      .join('\n') + '\n'
  );
}

/** Builds a self-contained HTML report: a summary table plus per-file source with line coloring. */
export function buildHtml(rows: FileRow[]): string {
  const totalLines = rows.reduce((sum, row) => sum + row.total, 0);
  const coveredLines = rows.reduce((sum, row) => sum + row.covered, 0);
  const overallPct = totalLines > 0 ? (coveredLines / totalLines) * 100 : 0;

  const summaryRows = rows
    .map(
      (row) =>
        `<tr><td><a href="#${escapeAttr(row.displayPath)}">${escapeHtml(row.displayPath)}</a></td>` +
        `<td class="${pctClass(row.pct)}">${row.pct.toFixed(2)}%</td>` +
        `<td>${row.covered}/${row.total}</td></tr>`,
    )
    .join('\n');

  const fileSections = rows.map(renderFileSection).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>qunitx coverage</title>
<style>
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  table { border-collapse: collapse; margin: 1rem 0; }
  th, td { padding: 0.35rem 0.9rem; border-bottom: 1px solid #e2e2e2; text-align: left; }
  th { background: #0d3349; color: #fff; }
  td.good { color: #157a3d; font-weight: 600; }
  td.ok { color: #9a7500; font-weight: 600; }
  td.bad { color: #b3261e; font-weight: 600; }
  .file { margin: 2rem 0; }
  .file h2 { font-size: 1rem; font-family: Menlo, Monaco, Consolas, monospace; }
  pre { margin: 0; border: 1px solid #e2e2e2; border-radius: 4px; overflow-x: auto; }
  .ln { display: flex; font-family: Menlo, Monaco, Consolas, monospace; font-size: 12px; line-height: 1.5; }
  .ln .no { width: 3.5rem; text-align: right; padding-right: 0.8rem; color: #999; user-select: none; flex: none; }
  .ln .ct { width: 3rem; text-align: right; padding-right: 0.8rem; color: #999; user-select: none; flex: none; }
  .ln .src { white-space: pre; }
  .ln.hit { background: #e6ffed; }
  .ln.miss { background: #ffeef0; }
  .ln.hit .ct { color: #157a3d; }
  .ln.miss .ct { color: #b3261e; }
</style>
</head>
<body>
<h1>qunitx coverage <span class="${pctClass(overallPct)}">${overallPct.toFixed(2)}%</span> (${coveredLines}/${totalLines} lines)</h1>
<table>
<thead><tr><th>File</th><th>% Lines</th><th>Lines</th></tr></thead>
<tbody>
${summaryRows}
</tbody>
</table>
${fileSections}
</body>
</html>
`;
}

function renderFileSection({ displayPath, pct, covered, total, fileCoverage }: FileRow): string {
  const header = `<div class="file" id="${escapeAttr(displayPath)}"><h2>${escapeHtml(displayPath)} — <span class="${pctClass(pct)}">${pct.toFixed(2)}%</span> (${covered}/${total})</h2>`;
  if (fileCoverage.sourceContent === null) {
    return `${header}<p>Source text unavailable.</p></div>`;
  }

  const rendered = fileCoverage.sourceContent
    .split('\n')
    .map((text, index) => {
      const lineNumber = index + 1;
      const isCoverable = fileCoverage.coverable.has(lineNumber);
      const count = fileCoverage.covered.get(lineNumber) ?? 0;
      const cls = !isCoverable ? '' : count > 0 ? 'hit' : 'miss';
      return `<div class="ln ${cls}"><span class="no">${lineNumber}</span><span class="ct">${isCoverable ? count : ''}</span><span class="src">${escapeHtml(text) || ' '}</span></div>`;
    })
    .join('');
  return `${header}<pre>${rendered}</pre></div>`;
}

function pctClass(pct: number): string {
  return pct >= GOOD_PCT ? 'good' : pct >= OK_PCT ? 'ok' : 'bad';
}

/**
 * The canonical key for a source file: POSIX separators, relative to the project root. Used for
 * both display and test-file exclusion so the two can't disagree. Paths reach us in two shapes —
 * OS paths from fsTree and `/`-separated paths from the source map — and on Windows those differ
 * by separator (and the map's may already be project-relative), so normalize before comparing.
 * Paths outside the project root are left absolute.
 */
function toDisplayPath(filePath: string, projectRoot: string): string {
  const posixPath = filePath.replace(/\\/g, '/');
  const posixRoot = projectRoot.replace(/\\/g, '/');
  return posixPath.startsWith(`${posixRoot}/`) ? posixPath.slice(posixRoot.length + 1) : posixPath;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
