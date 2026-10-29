import { Buffer } from 'node:buffer';
import * as Failure from '../result/failure.ts';
import { concatBytes } from '../utils/concat-bytes.ts';
import * as CSS from './css.ts';
import * as JPEG from './jpeg.ts';
import * as Outputs from './outputs.ts';
import type { RecordedFile } from './index.ts';
import type { Settings } from './options.ts';
import type { Page } from 'playwright-core';

/**
 * The named paper sizes a PDF can be printed on, as Chromium knows them.
 *
 * ```ts
 * import { PAPERS } from './pdf.ts';
 *
 * PAPERS.A4; // { width: '210mm', height: '297mm' }
 * ```
 */
export const PAPERS: Record<string, { width: string; height: string }> = {
  Letter: { width: '8.5in', height: '11in' },
  Legal: { width: '8.5in', height: '14in' },
  Tabloid: { width: '11in', height: '17in' },
  Ledger: { width: '17in', height: '11in' },
  A0: { width: '841mm', height: '1189mm' },
  A1: { width: '594mm', height: '841mm' },
  A2: { width: '420mm', height: '594mm' },
  A3: { width: '297mm', height: '420mm' },
  A4: { width: '210mm', height: '297mm' },
  A5: { width: '148mm', height: '210mm' },
  A6: { width: '105mm', height: '148mm' },
};

// The document's size, and never less than the window's: Firefox reports a short page's
// scrollHeight as its content alone, and in quirks mode its clientHeight too.
const CODE_TO_GET_DOCUMENT_SIZE = `(() => {
  const root = document.documentElement;
  return {
    width: Math.max(root.scrollWidth, root.clientWidth),
    height: Math.max(root.scrollHeight, root.clientHeight, innerHeight),
  };
})()`;

/**
 * How a PDF is made. Every field is optional.
 *
 * ```ts
 * const pdf: PdfOptions = { paper: 'A4', landscape: true, margin: '1cm', media: 'print' };
 * ```
 */
export interface PdfOptions {
  /**
   * `vector`: printed by the browser — text stays text, links stay links (Chromium only).
   * `raster`: screenshots on pages, the same in every engine. `auto` (the default): vector
   * where the engine can, raster where it can't.
   */
  mode?: 'auto' | 'vector' | 'raster';
  /**
   * `fit` (the default): one page exactly the size of the page, as `record` shows it. A named
   * paper (`A4`, `Letter`, … see {@link PAPERS}), or a size: `{ width: '20cm', height: 600 }`,
   * numbers in CSS pixels, strings in px, in, cm or mm.
   */
  paper?: 'fit' | string | { width: string | number; height: string | number };
  /** Turn a named paper sideways. */
  landscape?: boolean;
  /** Around the content: one length for every side, or each side its own. Defaults to 0. */
  margin?:
    | string
    | number
    | {
        top?: string | number;
        right?: string | number;
        bottom?: string | number;
        left?: string | number;
      };
  /** Zoom of the printed page, 0.1 to 2. Defaults to 1. */
  scale?: number;
  /** Print backgrounds — colors and images — as the screen shows them. Defaults to true. */
  background?: boolean;
  /** The CSS media the page is laid out for: `screen` (the default) or its `print` styles. */
  media?: 'screen' | 'print';
  /**
   * HTML printed at the top and bottom of every page (vector only). Elements with the classes
   * `date`, `title`, `url`, `pageNumber` and `totalPages` are filled in. Give the margin room.
   */
  header?: string;
  /** Like `header`, at the bottom. */
  footer?: string;
  /** Which pages to keep, as in a print dialog: `1-3, 5` (vector only). */
  pageRanges?: string;
  /** A document outline from the page's headings, for a PDF reader's sidebar (vector only). */
  outline?: boolean;
}

// Options only a browser's own printing can honor.
const VECTOR_ONLY = ['header', 'footer', 'pageRanges', 'outline'] as const;

/**
 * PDF settings the engine cannot print: vector mode outside chromium, or a setting only vector
 * mode has asked of raster.
 *
 * ```ts
 * import { UnprintablePdf } from './pdf.ts';
 *
 * UnprintablePdf({ reason: 'outline needs vector mode; mode is raster' }).data.reason;
 * // 'outline needs vector mode; mode is raster'
 * ```
 */
export const UnprintablePdf: Failure.FailureFactory<'UnprintablePdf', { reason: string }> =
  Failure.define(
    'UnprintablePdf',
    (data: { reason: string }) => `cannot print this PDF: ${data.reason}`,
  );

/**
 * Whether these options can be printed by `browser`, and how: the mode to use, or why not.
 *
 * ```ts
 * import { getMode, UnprintablePdf } from './pdf.ts';
 *
 * getMode({}, 'chromium'); // 'vector'
 * getMode({}, 'webkit'); // 'raster'
 * const refused = getMode({ mode: 'vector' }, 'firefox');
 * UnprintablePdf.is(refused) && refused.data.reason; // 'mode vector needs chromium: firefox cannot print a page to PDF'
 * ```
 */
export function getMode(
  options: PdfOptions,
  browser: 'chromium' | 'firefox' | 'webkit',
): 'vector' | 'raster' | Failure.Of<typeof UnprintablePdf> {
  const mode = options.mode ?? 'auto';
  const vector = mode === 'vector' || (mode === 'auto' && browser === 'chromium');
  const vectorOnly = vector
    ? undefined
    : VECTOR_ONLY.find((option) => options[option] !== undefined);
  if (vector && browser !== 'chromium') {
    return UnprintablePdf({
      reason: `mode vector needs chromium: ${browser} cannot print a page to PDF`,
    });
  } else if (vectorOnly) {
    return UnprintablePdf({
      reason:
        mode === 'raster'
          ? `${vectorOnly} needs vector mode; mode is raster`
          : `${vectorOnly} needs vector mode, which needs chromium`,
    });
  }
  return vector ? 'vector' : 'raster';
}

/**
 * A PDF made from a page: its bytes, how many pages it has, and the size of each, in CSS pixels.
 *
 * ```ts
 * import type { PdfDocument } from './pdf.ts';
 *
 * const pdf: PdfDocument = { bytes: new Uint8Array(0), pageCount: 2, width: 794, height: 1123 };
 * pdf.pageCount; // 2 — an A4 page, twice
 * ```
 */
export interface PdfDocument {
  /** The PDF file, ready to write. */
  bytes: Uint8Array;
  /** Pages in it. */
  pageCount: number;
  /** Each page's width, in CSS pixels. */
  width: number;
  /** Each page's height, in CSS pixels. */
  height: number;
}

/**
 * What `page` shows, as a PDF made the way `options` say: printed by the browser (vector), or its
 * screenshots laid onto pages (raster). `mode` is what {@link getMode} decided. Nothing is
 * written; the bytes are returned.
 *
 * ```ts
 * import * as PDF from './pdf.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live page.
 * async function toPdf(page: Page) {
 *   const pdf = await PDF.fromPage(page, { paper: 'A4', margin: '12mm' }, 'vector', { title: 'Home', quality: 90 });
 *   return pdf.pageCount;
 * }
 * ```
 */
export async function fromPage(
  page: Page,
  options: PdfOptions,
  mode: 'vector' | 'raster',
  document: { title: string; quality: number },
): Promise<PdfDocument> {
  await page.emulateMedia({ media: options.media ?? 'screen' });
  try {
    const paper = await paperDimensionsOf(page, options);
    const margin = marginsOf(options.margin);
    return mode === 'vector'
      ? await vectorPdf(page, options, paper, margin)
      : await rasterPdf(page, options, paper, margin, document);
  } finally {
    await page.emulateMedia({ media: null });
  }
}

// Printed by the browser: text and links kept.
async function vectorPdf(
  page: Page,
  options: PdfOptions,
  { width, height }: { width: string | number; height: string | number },
  margin: Record<'top' | 'right' | 'bottom' | 'left', string | number>,
): Promise<PdfDocument> {
  const header = options.header ?? '';
  const footer = options.footer ?? '';
  // A Buffer, whose slice() shares its bytes: copied into the plain Uint8Array this returns.
  const bytes = new Uint8Array(
    await page.pdf({
      width: cssLength(width),
      height: cssLength(height),
      margin: Object.fromEntries(
        Object.entries(margin).map(([side, length]) => [side, cssLength(length)]),
      ),
      scale: options.scale ?? 1,
      printBackground: options.background ?? true,
      displayHeaderFooter: Boolean(options.header || options.footer),
      // Chromium prints its own default header when given none and asked to show one.
      headerTemplate: header || '<span></span>',
      footerTemplate: footer || '<span></span>',
      pageRanges: options.pageRanges,
      outline: options.outline ?? false,
      tagged: options.outline ?? false,
    }),
  );
  return {
    bytes,
    pageCount: getTotalPageCount(bytes),
    width: Math.round(CSS.toPixels(width)),
    height: Math.round(CSS.toPixels(height)),
  };
}

// The page size, with `fit` measured from the page itself and a named paper turned if asked.
async function paperDimensionsOf(
  page: Page,
  options: PdfOptions,
): Promise<{ width: string | number; height: string | number }> {
  const paper = options.paper ?? 'fit';
  if (paper === 'fit') {
    const scale = options.scale ?? 1;
    const size = await page.evaluate<{ width: number; height: number }>(CODE_TO_GET_DOCUMENT_SIZE);
    const margin = marginsInPixels(marginsOf(options.margin));
    return {
      width: Math.ceil(size.width * scale + margin.left + margin.right),
      height: Math.ceil(size.height * scale + margin.top + margin.bottom),
    };
  }
  const size = typeof paper === 'string' ? PAPERS[paper] : paper;
  return options.landscape ? { width: size.height, height: size.width } : size;
}

function marginsOf(
  margin: PdfOptions['margin'],
): Record<'top' | 'right' | 'bottom' | 'left', string | number> {
  if (margin === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
  else if (typeof margin !== 'object') {
    return { top: margin, right: margin, bottom: margin, left: margin };
  }
  return {
    top: margin.top ?? 0,
    right: margin.right ?? 0,
    bottom: margin.bottom ?? 0,
    left: margin.left ?? 0,
  };
}

function marginsInPixels(
  margin: Record<'top' | 'right' | 'bottom' | 'left', string | number>,
): Record<'top' | 'right' | 'bottom' | 'left', number> {
  return {
    top: CSS.toPixels(margin.top),
    right: CSS.toPixels(margin.right),
    bottom: CSS.toPixels(margin.bottom),
    left: CSS.toPixels(margin.left),
  };
}

function cssLength(length: string | number): string {
  return typeof length === 'number' ? `${length}px` : length;
}

// Screenshots on pages: the whole page shot once, then cut into page-high slices that each fill
// the space inside the margins, as a printer would break it, minus the browser's reflow.
async function rasterPdf(
  page: Page,
  options: PdfOptions,
  paper: { width: string | number; height: string | number },
  margin: Record<'top' | 'right' | 'bottom' | 'left', string | number>,
  document: { title: string; quality: number },
): Promise<PdfDocument> {
  const scale = options.scale ?? 1;
  const pageWidth = CSS.toPixels(paper.width);
  const pageHeight = CSS.toPixels(paper.height);
  const edges = marginsInPixels(margin);
  const inner = {
    x: edges.left,
    y: edges.top,
    width: pageWidth - edges.left - edges.right,
    height: pageHeight - edges.top - edges.bottom,
  };
  const content = await page.evaluate<{ width: number; height: number }>(CODE_TO_GET_DOCUMENT_SIZE);
  // CSS pixels of the page that one page of paper holds, at the asked-for zoom.
  const across = inner.width / scale;
  const slice = Math.max(1, Math.floor((inner.height / scale) * (content.width / across)));
  const images: PdfImage[] = [];
  // Taken off again after: the page's stills, made after the PDF, keep their background.
  const noBackground =
    (options.background ?? true)
      ? null
      : await page.addStyleTag({ content: 'html, body { background: #fff !important; }' });
  try {
    for (let top = 0; top < content.height; top += slice) {
      const jpeg = await page.screenshot({
        type: 'jpeg',
        quality: document.quality,
        fullPage: true,
        clip: { x: 0, y: top, width: content.width, height: Math.min(slice, content.height - top) },
      });
      const pixels = JPEG.getDimensions(jpeg);
      const drawn = { width: inner.width, height: (inner.width * pixels.height) / pixels.width };
      images.push({
        jpeg,
        pixels,
        page: { width: pageWidth, height: pageHeight },
        at: { x: inner.x, y: inner.y, ...drawn },
      });
    }
  } finally {
    await noBackground?.evaluate((style: { remove(): void }) => style.remove());
  }
  return {
    bytes: encode(images, { title: document.title }),
    pageCount: images.length,
    width: Math.round(pageWidth),
    height: Math.round(pageHeight),
  };
}

/**
 * One page of a PDF that is a picture: the JPEG, its size in pixels, the page's size and where on
 * it the picture goes, both in CSS pixels from the top-left corner.
 *
 * ```ts
 * const image: PdfImage = {
 *   jpeg: new Uint8Array(0),
 *   pixels: { width: 1280, height: 720 },
 *   page: { width: 1280, height: 720 },
 *   at: { x: 0, y: 0, width: 1280, height: 720 },
 * };
 * ```
 */
export interface PdfImage {
  /** The picture, placed as it is. */
  jpeg: Uint8Array;
  /** Its size in pixels. */
  pixels: { width: number; height: number };
  /** The page's size, in CSS pixels. */
  page: { width: number; height: number };
  /** Where the picture goes on it, from its top-left corner, in CSS pixels. */
  at: { x: number; y: number; width: number; height: number };
}

/**
 * A PDF of pictures, a page each: JPEG streams placed as they are, nothing re-encoded. Sizes are
 * CSS pixels, written as PDF points (3/4 of a pixel each).
 *
 * ```ts
 * import { encode } from './pdf.ts';
 *
 * const pdf = encode([], { title: 'Empty' });
 * new TextDecoder().decode(pdf.subarray(0, 8)); // '%PDF-1.4'
 * ```
 */
export function encode(images: PdfImage[], document: { title: string }): Uint8Array {
  const point = (pixels: number) => +(pixels * 0.75).toFixed(2);
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: Uint8Array | string) => {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (id: number, body: (Uint8Array | string)[]) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    body.forEach(push);
    push('\nendobj\n');
  };
  // 1 catalog, 2 pages, 3 info, then three objects a page: the page, its content, its image.
  const pageIds = images.map((_, index) => 4 + index * 3);
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  object(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  object(2, [
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${images.length} >>`,
  ]);
  object(3, [`<< /Title ${pdfString(document.title)} /Producer (qunitx record) >>`]);
  images.forEach((image, index) => {
    const id = pageIds[index];
    const width = point(image.page.width);
    const height = point(image.page.height);
    const draw = `q ${point(image.at.width)} 0 0 ${point(image.at.height)} ${point(image.at.x)} ${+(height - point(image.at.y) - point(image.at.height)).toFixed(2)} cm /Im0 Do Q`;
    object(id, [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`,
    ]);
    object(id + 1, [`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`]);
    object(id + 2, [
      `<< /Type /XObject /Subtype /Image /Width ${image.pixels.width} /Height ${image.pixels.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.jpeg.length} >>\nstream\n`,
      image.jpeg,
      '\nendstream',
    ]);
  });
  const count = 4 + images.length * 3;
  const xref = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return concatBytes(chunks);
}

// A PDF literal string. Plain ASCII is written as it is, its three special characters escaped;
// anything else becomes big-endian UTF-16 behind a byte-order mark, which every reader shows.
function pdfString(text: string): string {
  if (/^\p{ASCII}*$/u.test(text)) {
    return `(${text.replace(/[\\()]/g, (character) => `\\${character}`)})`;
  }
  return `<feff${Buffer.from(text, 'utf16le').swap16().toString('hex')}>`;
}

/**
 * How many pages a PDF has, from its page objects.
 *
 * ```ts
 * import { getTotalPageCount, encode } from './pdf.ts';
 *
 * getTotalPageCount(encode([], { title: 'x' })); // 0
 * ```
 */
export function getTotalPageCount(pdf: Uint8Array): number {
  const text = new TextDecoder('latin1').decode(pdf);
  return (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

/**
 * Writes a PDF of `page` where it ended to `output`, made as {@link fromPage} makes it, titled
 * after the page, or `name` when it has none.
 *
 * ```ts
 * import * as PDF from './pdf.ts';
 * import type { Output } from './outputs.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live page.
 * async function print(page: Page, output: Output) {
 *   return (await PDF.record(page, output, { paper: 'A4' }, 'vector', 'home', { quality: 90 })).frames;
 * }
 * ```
 */
export async function record(
  page: Page,
  output: Outputs.Output,
  options: PdfOptions,
  mode: 'vector' | 'raster',
  name: string,
  { quality }: Pick<Settings, 'quality'>,
): Promise<RecordedFile> {
  const title = (await page.title().catch(() => '')) || name;
  const { bytes, width, height, pageCount } = await fromPage(page, options, mode, {
    title,
    quality,
  });
  return Outputs.write(output, bytes, { width, height, frames: pageCount });
}
