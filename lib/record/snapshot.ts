import fs from 'node:fs';
import path from 'node:path';
import * as Diff from './diff.ts';
import * as PNG from './png.ts';
import * as Report from './report.ts';
import type { SnapshotComparison } from './index.ts';

/**
 * Writes `bytes` to `file`, making its directory first.
 *
 * ```ts
 * import { write } from './snapshot.ts';
 *
 * // Defined, not invoked: writes to disk.
 * async function save(png: Uint8Array) {
 *   await write('/shots/home.png', png);
 * }
 * ```
 */
export async function write(file: string, bytes: Uint8Array): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, bytes);
}

/**
 * Compares a new screenshot with the baseline at `file` and writes what that calls for: the
 * baseline itself when there was none (`new`), nothing when it matches (`unchanged`), the new one
 * over it when changes are accepted (`updated`), and otherwise `<name>.new.png` and
 * `<name>.diff.png` beside it for review (`changed`). Shared by `qunitx record --compare` and
 * `qunitxSnapshot()` in tests, so a snapshot means the same thing in both.
 *
 * ```ts
 * import { compare } from './snapshot.ts';
 *
 * // Defined, not invoked: reads and writes files beside the baseline.
 * async function check(png: Uint8Array) {
 *   return (await compare('/shots/home.png', png, { threshold: 0.1, maxDiff: 0, accept: false })).status;
 * }
 * ```
 */
export async function compare(
  file: string,
  current: Uint8Array,
  options: { threshold: number; maxDiff: number; accept: boolean },
): Promise<SnapshotComparison> {
  const stem = file.slice(0, -path.extname(file).length);
  const [diffPath, currentPath] = [`${stem}.diff.png`, `${stem}.new.png`];
  const image = PNG.decode(current);
  const baseline = await fs.promises.readFile(file).catch(() => null);
  const before = baseline && PNG.decode(baseline);
  const result = before && Diff.compare(before, image, { threshold: options.threshold });
  const status = !result
    ? 'new'
    : result.sameSize && result.changedPixels <= options.maxDiff
      ? 'unchanged'
      : options.accept
        ? 'updated'
        : 'changed';
  const changed = status === 'changed';
  await Promise.all([
    status === 'new' || status === 'updated' ? write(file, current) : null,
    changed ? write(currentPath, current) : fs.promises.rm(currentPath, { force: true }),
    changed
      ? PNG.encode(Diff.draw(before!, image, result!)).then((png) => write(diffPath, png))
      : fs.promises.rm(diffPath, { force: true }),
  ]);
  return {
    status,
    changedPixels: result?.changedPixels ?? 0,
    totalPixels: result?.totalPixels ?? image.width * image.height,
    diffPath: changed ? diffPath : null,
    currentPath: changed ? currentPath : null,
  };
}

/**
 * Writes the reviews of a set of compared snapshots into `directory`, each only when asked for,
 * and says where: the review page as `report.html`, `report.pdf` or both (`report` takes the
 * formats `record`'s option does), and the pull-request comment, `comment.md`. A PDF is printed
 * by `print`, given the written `report.html`, which a PDF alone leaves out again.
 *
 * ```ts
 * import { writeReviews } from './snapshot.ts';
 *
 * // Defined, not invoked: writes report.html beside the snapshots.
 * async function review(entries: Parameters<typeof writeReviews>[0]) {
 *   return (await writeReviews(entries, { directory: '/shots', report: true })).reportPath; // '/shots/report.html'
 * }
 * ```
 */
export async function writeReviews(
  entries: Report.ReportEntry[],
  options: {
    directory: string;
    report?: boolean | 'html' | 'pdf' | ('html' | 'pdf')[];
    prComment?: boolean;
    imagesUrl?: string;
    reportUrl?: string;
    print?: (reportPath: string) => Promise<Uint8Array>;
  },
): Promise<{
  reportPath: string | null;
  reportPdfPath: string | null;
  commentPath: string | null;
}> {
  // `report: true` is the HTML one; a format or a list of them is as given.
  const formats = options.report === true ? ['html'] : [options.report || []].flat();
  // Where each review goes, when asked for. A PDF report is printed from the HTML one, which is
  // removed after unless it was asked for too.
  const commentPath =
    options.prComment && options.imagesUrl ? path.join(options.directory, 'comment.md') : null;
  const htmlPath = formats.length ? path.join(options.directory, 'report.html') : null;
  const reportPdfPath = formats.includes('pdf') ? path.join(options.directory, 'report.pdf') : null;
  if (reportPdfPath && !options.print) throw new Error('a PDF report needs a browser to print it');
  const encode = (text: string) => new TextEncoder().encode(text);
  await Promise.all([
    commentPath &&
      write(
        commentPath,
        encode(
          Report.renderComment(entries, {
            directory: options.directory,
            imagesUrl: options.imagesUrl!,
            reportUrl: options.reportUrl,
          }),
        ),
      ),
    htmlPath &&
      write(
        htmlPath,
        encode(Report.render(entries, { directory: options.directory, generatedAt: new Date() })),
      ),
  ]);
  if (htmlPath && reportPdfPath) {
    await write(reportPdfPath, await options.print!(htmlPath));
    if (!formats.includes('html')) await fs.promises.rm(htmlPath, { force: true });
  }
  return { reportPath: formats.includes('html') ? htmlPath : null, reportPdfPath, commentPath };
}
