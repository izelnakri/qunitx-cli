import path from 'node:path';
import type { SnapshotComparison } from './index.ts';

/**
 * One snapshot as the report shows it: where its files are, and how it compared.
 *
 * ```ts
 * const entry: ReportEntry = {
 *   path: '/shots/home.png',
 *   width: 1280,
 *   height: 720,
 *   comparison: { status: 'unchanged', changedPixels: 0, totalPixels: 921_600, diffPath: null, currentPath: null },
 * };
 * ```
 */
export interface ReportEntry {
  /** The baseline's absolute path. */
  path: string;
  /** In device pixels. */
  width: number;
  /** In device pixels. */
  height: number;
  /** How it compared. */
  comparison: SnapshotComparison;
}

// Changed first: they are what the reader opened the page for.
const ORDER: Record<SnapshotComparison['status'], number> = {
  changed: 0,
  new: 1,
  updated: 2,
  unchanged: 3,
};

/**
 * The review page for a `--compare` run, as one self-contained HTML file to write beside the
 * snapshots. Images are linked by relative path, so the folder can be opened from disk, uploaded as
 * a CI artifact or served as-is; the page itself needs nothing from the network.
 *
 * Changed snapshots come first, each with its diff (before and after side by side, every change
 * boxed on both) and a slider that wipes from the baseline to the new screenshot: a moved pixel is
 * easier to see than to describe. New, updated and unchanged snapshots follow, smaller.
 *
 * ```ts
 * import { render } from './report.ts';
 *
 * const html = render(
 *   [{
 *     path: '/shots/home.png',
 *     width: 4,
 *     height: 4,
 *     comparison: { status: 'changed', changedPixels: 2, totalPixels: 16, diffPath: '/shots/home.diff.png', currentPath: '/shots/home.new.png' },
 *   }],
 *   { directory: '/shots', generatedAt: new Date(0) },
 * );
 * html.includes('src="home.diff.png"'); // true
 * ```
 */
export function render(
  entries: ReportEntry[],
  options: { directory: string; generatedAt?: Date },
): string {
  const sorted = [...entries].sort(
    (a, b) =>
      ORDER[a.comparison.status] - ORDER[b.comparison.status] || a.path.localeCompare(b.path),
  );
  const counts = sorted.reduce<Record<string, number>>((tally, entry) => {
    tally[entry.comparison.status] = (tally[entry.comparison.status] ?? 0) + 1;
    return tally;
  }, {});
  const link = (file: string) =>
    escape(
      path.relative(options.directory, file).split(path.sep).map(encodeURIComponent).join('/'),
    );
  const name = (file: string) =>
    escape(path.relative(options.directory, file).split(path.sep).join('/'));
  const verdict = counts.changed
    ? `${counts.changed} changed`
    : sorted.length
      ? 'No visual changes'
      : 'No snapshots';
  const summary = (['changed', 'new', 'updated', 'unchanged'] as const)
    .filter((status) => counts[status])
    .map((status) => `<li class="${status}"><b>${counts[status]}</b> ${status}</li>`)
    .join('');

  const cards = sorted
    .map((entry) => {
      const { status, changedPixels, totalPixels, diffPath, currentPath } = entry.comparison;
      const size = `${entry.width}×${entry.height}`;
      if (status !== 'changed') {
        return `<article class="snapshot ${status}">
  <header><h2>${name(entry.path)}</h2><span class="status">${status}</span><span class="meta">${size}</span></header>
  <a href="${link(entry.path)}"><img loading="lazy" src="${link(entry.path)}" alt="${name(entry.path)}" width="${entry.width}" height="${entry.height}"></a>
</article>`;
      }
      const share = ((changedPixels / totalPixels) * 100).toFixed(2);
      const after = currentPath ? link(currentPath) : '';
      return `<article class="snapshot changed">
  <header><h2>${name(entry.path)}</h2><span class="status">changed</span><span class="meta">${changedPixels.toLocaleString('en-US')} pixels · ${share}% · ${size}</span></header>
  ${
    diffPath
      ? `<figure><figcaption>Before and after: each change is boxed in the same place on both</figcaption><a href="${link(diffPath)}"><img src="${link(diffPath)}" alt="Before and after of ${name(entry.path)}"></a></figure>`
      : ''
  }
  ${
    after
      ? `<div class="wipe" style="--split: 50%">
    <img src="${link(entry.path)}" alt="" width="${entry.width}" height="${entry.height}">
    <img class="after" src="${after}" alt="" width="${entry.width}" height="${entry.height}">
    <input type="range" min="0" max="100" value="50" aria-label="Wipe between baseline and new for ${name(entry.path)}">
  </div>
  <p class="hint">Drag to wipe: baseline on the left, new on the right.</p>`
      : ''
  }
</article>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(verdict)} · qunitx snapshots</title>
<style>
:root { --bg: #f6f7f9; --card: #fff; --ink: #171b22; --soft: #5a6272; --rule: #dfe3ea; --changed: #d6303a; --new: #1c7ed6; --updated: #7048e8; --unchanged: #2f9e44; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f1217; --card: #171b22; --ink: #e8ebf1; --soft: #a0a8b8; --rule: #2a3140; --changed: #ff6b74; --new: #4dabf7; --updated: #9775fa; --unchanged: #51cf66; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px max(16px, 4vw); background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
h1 { margin: 0 0 6px; font-size: 1.7rem; }
.generated { color: var(--soft); margin: 0 0 18px; font-size: 13px; }
.summary { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; padding: 0; margin: 0 0 28px; }
.summary li { padding: 6px 12px; border-radius: 999px; background: var(--card); border: 1px solid var(--rule); }
.summary li b { margin-right: 4px; }
.summary .changed b { color: var(--changed); } .summary .new b { color: var(--new); } .summary .updated b { color: var(--updated); } .summary .unchanged b { color: var(--unchanged); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.snapshot { background: var(--card); border: 1px solid var(--rule); border-radius: 10px; padding: 14px; min-width: 0; }
.snapshot.changed { grid-column: 1 / -1; border-color: var(--changed); }
.snapshot header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; margin-bottom: 10px; }
.snapshot h2 { margin: 0; font-size: 15px; font-family: ui-monospace, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.status { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.changed .status { color: var(--changed); } .new .status { color: var(--new); } .updated .status { color: var(--updated); } .unchanged .status { color: var(--unchanged); }
.meta { color: var(--soft); font-size: 13px; }
img { display: block; max-width: 100%; height: auto; border-radius: 4px; border: 1px solid var(--rule); background: repeating-conic-gradient(#0001 0 25%, transparent 0 50%) 0 0 / 16px 16px; }
figure { margin: 0; min-width: 0; }
figcaption { font-size: 12px; font-weight: 600; color: var(--soft); margin-bottom: 6px; }
.wipe { position: relative; margin-top: 14px; max-width: max-content; }
.wipe img { margin: 0; }
.wipe::after { content: ""; position: absolute; top: 0; bottom: 0; left: var(--split); width: 2px; margin-left: -1px; background: var(--changed); pointer-events: none; }
.wipe .after { position: absolute; inset: 0; clip-path: inset(0 0 0 var(--split)); }
.wipe input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: ew-resize; margin: 0; }
.hint { color: var(--soft); font-size: 13px; margin: 6px 0 0; }
</style>
</head>
<body>
<h1>${escape(verdict)}</h1>
<p class="generated">qunitx record --compare${options.generatedAt ? ` · ${escape(options.generatedAt.toISOString())}` : ''}</p>
<ul class="summary">${summary}</ul>
<main class="grid">
${cards}
</main>
<script>
for (const wipe of document.querySelectorAll('.wipe')) {
  const input = wipe.querySelector('input');
  input.addEventListener('input', () => wipe.style.setProperty('--split', input.value + '%'));
}
</script>
</body>
</html>
`;
}

/**
 * The first line of every comment {@link renderComment} writes: a workflow finds its own earlier comment
 * by it and edits that one, so a pull request carries one visual-diff comment however often it runs.
 *
 * ```ts
 * import { COMMENT_MARKER } from './report.ts';
 *
 * COMMENT_MARKER; // '<!-- qunitx-visual-diff -->'
 * ```
 */
export const COMMENT_MARKER = '<!-- qunitx-visual-diff -->';

/**
 * The pull-request comment for a `--compare` run, as GitHub-flavored Markdown.
 *
 * With changes, each changed snapshot gets its name, how much changed and its diff (before and
 * after side by side, every change boxed on both), linked under `imagesUrl`: wherever the
 * workflow published the output directory, since a comment cannot carry images of its own.
 * Without changes it is one line: "No visual changes in this PR, good job". New snapshots are
 * listed by name; `reportUrl`, when given, is where "Download the full report" points.
 *
 * ```ts
 * import { renderComment } from './report.ts';
 *
 * const unchanged = { status: 'unchanged' as const, changedPixels: 0, totalPixels: 16, diffPath: null, currentPath: null };
 * renderComment([{ path: '/shots/home.png', width: 4, height: 4, comparison: unchanged }], {
 *   directory: '/shots',
 *   imagesUrl: 'https://example.com/shots/',
 * }).includes('No visual changes in this PR, good job'); // true
 * ```
 */
export function renderComment(
  entries: ReportEntry[],
  options: { directory: string; imagesUrl: string; reportUrl?: string },
): string {
  const base = options.imagesUrl.endsWith('/') ? options.imagesUrl : `${options.imagesUrl}/`;
  const url = (file: string) =>
    base + path.relative(options.directory, file).split(path.sep).map(encodeURIComponent).join('/');
  const name = (file: string) =>
    escape(path.relative(options.directory, file).split(path.sep).join('/'));
  const changed = entries.filter((entry) => entry.comparison.status === 'changed');
  const added = entries.filter((entry) => entry.comparison.status === 'new');
  const footer = options.reportUrl ? [`[Download the full report](${options.reportUrl})`] : [];

  if (changed.length === 0) {
    const created = added.length
      ? [
          `${added.length} new snapshot${added.length === 1 ? '' : 's'}: ${added.map((entry) => `\`${name(entry.path)}\``).join(', ')}`,
        ]
      : [];
    return [
      COMMENT_MARKER,
      '### No visual changes in this PR, good job',
      ...created,
      ...footer,
      '',
    ].join('\n\n');
  }

  const sections = changed.map((entry) => {
    const { changedPixels, totalPixels, diffPath } = entry.comparison;
    const share = ((changedPixels / totalPixels) * 100).toFixed(2);
    const heading = `<b><code>${name(entry.path)}</code></b> · ${changedPixels.toLocaleString('en-US')} px · ${share}%`;
    return diffPath
      ? `${heading}\n\n<a href="${escape(url(diffPath))}"><img src="${escape(url(diffPath))}" alt="before and after of ${name(entry.path)}"></a>`
      : heading;
  });
  const total = entries.length;
  return [
    COMMENT_MARKER,
    `### Visual changes: ${changed.length} of ${total} snapshot${total === 1 ? '' : 's'}`,
    ...sections,
    ...(added.length
      ? [
          `${added.length} new snapshot${added.length === 1 ? '' : 's'}: ${added.map((entry) => `\`${name(entry.path)}\``).join(', ')}`,
        ]
      : []),
    'Each diff shows before and after side by side, every change boxed in the same place on both. If these changes are intended, accept them by running with `--update`.',
    ...footer,
    '',
  ].join('\n\n');
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}
