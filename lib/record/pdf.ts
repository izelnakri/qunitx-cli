import { Buffer } from 'node:buffer';
import * as Failure from '../result/failure.ts';
import { concatBytes } from '../utils/concat-bytes.ts';
import * as CSS from './css.ts';
import * as JPEG from './jpeg.ts';
import * as Outputs from './outputs.ts';
import type { RecordedFile } from './index.ts';
import type { Settings } from './options.ts';
import type { Page } from 'playwright-core';
import { hideFields, layoutAt, pageBreaks, readLayout, type PageLayout } from './pdf-layout.ts';
import { nameFields, placeFields, type PaperGeometry, type PdfField } from './pdf-fields.ts';
import { fillPdf, slicePdf } from './pdf-forms.ts';
import { openPdf, readObject, resolve, type PdfValue } from './pdf-edit.ts';

export type { PdfField } from './pdf-fields.ts';

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
  /**
   * The page's form controls become form fields a PDF reader fills in — text, check boxes, radio
   * buttons, selects, submit and reset — holding what the page holds. Defaults to true.
   */
  forms?: boolean;
  /**
   * Called with every PDF made, and its fields, before it is written: returns the bytes to write.
   * For what this does not do — signatures, other fonts, scripts — with a PDF library of your own.
   */
  postProcess?: (
    pdf: Uint8Array,
    made: { fields: PdfField[]; pageCount: number },
  ) => Uint8Array | Promise<Uint8Array>;
}

/**
 * A PDF made from a page: its bytes, how many pages it has and the size of each in CSS pixels, its
 * form fields, and anything it could not do as asked, for whoever made it to know.
 *
 * ```ts
 * import type { PdfDocument } from './pdf.ts';
 *
 * const pdf: PdfDocument = { bytes: new Uint8Array(0), pageCount: 2, width: 794, height: 1123, fields: [], notices: [] };
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
  /** Its fillable fields. */
  fields: PdfField[];
  /** What it could not do as asked, and why. */
  notices: string[];
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
 * What `page` shows, as a PDF made the way `options` say: printed by the browser (vector), or its
 * screenshots laid onto pages (raster), its form controls made fields to fill in. `mode` is what
 * {@link getMode} decided. Nothing is written; the bytes are returned.
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
    const printed =
      mode === 'vector' ? await vectorPdf(page, options) : await rasterPdf(page, options, document);
    if (!options.postProcess) return printed;
    const bytes = await options.postProcess(printed.bytes, {
      fields: printed.fields,
      pageCount: printed.pageCount,
    });
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError(`pdf.postProcess returned ${typeof bytes}, not the PDF's bytes`);
    }
    return { ...printed, bytes, pageCount: getTotalPageCount(bytes) };
  } finally {
    await page.emulateMedia({ media: null });
  }
}

// Printed by Chromium: as it paginates, or, when the page has a form to fill in, as one tall
// sheet cut into pages where its layout says, so each field lands where its control printed.
async function vectorPdf(page: Page, options: PdfOptions): Promise<PdfDocument> {
  const margin = pixelMargins(options.margin);
  const scale = options.scale ?? 1;
  const notices: string[] = [];
  const controls =
    options.forms !== false &&
    (await page.evaluate<boolean>(`Boolean(document.querySelector('input, textarea, select'))`));
  if (controls && (options.header || options.footer)) {
    notices.push(
      "forms: printed, not fillable: a header or footer needs the browser's own page breaks",
    );
  }
  if (!controls || options.header || options.footer) {
    return { ...(await nativePdf(page, options)), fields: [], notices };
  }
  const named = (options.paper ?? 'fit') !== 'fit';
  const paper = named ? await paperDimensionsOf(page, options) : null;
  const inner = paper && {
    width: CSS.toPixels(paper.width) - margin.left - margin.right,
    height: CSS.toPixels(paper.height) - margin.top - margin.bottom,
  };
  const viewport =
    page.viewportSize() ??
    (await page.evaluate<{ width: number; height: number }>(
      '({ width: innerWidth, height: innerHeight })',
    ));
  const { layout, restore } = await layoutAt(
    page,
    inner ? { width: inner.width / scale, height: inner.height / scale } : viewport,
  );
  // Hidden inputs, file pickers and the like have no field: Chromium paginates as it would.
  if (!layout.fields.length) {
    await restore();
    return { ...(await nativePdf(page, options)), fields: [], notices };
  }
  try {
    const width = inner ? inner.width / scale : layout.width;
    const size = paper
      ? { width: CSS.toPixels(paper.width), height: CSS.toPixels(paper.height) }
      : {
          width: Math.ceil(width * scale + margin.left + margin.right),
          height: Math.ceil(layout.height * scale + margin.top + margin.bottom),
        };
    const pageHeight = inner ? inner.height / scale : layout.height;
    const geometry: PaperGeometry = {
      starts: inner ? pageBreaks(layout.height, pageHeight, layout.blocks, layout.forced) : [0],
      pageHeight,
      paper: size,
      margin,
      scale,
    };
    const keep = options.pageRanges
      ? keptPages(options.pageRanges, geometry.starts.length)
      : geometry.starts.map((_, index) => index);
    const placed = formFields(layout, geometry, notices);
    const fields = placed.flatMap((field) =>
      keep.includes(field.page) ? [{ ...field, page: keep.indexOf(field.page) }] : [],
    );
    const unhide = await hideFields(page, hiddenIndices(placed));
    let tall: Uint8Array;
    try {
      tall = await page.pdf({
        width: `${width}px`,
        // A pixel to spare, so rounding never spills the last line onto a sheet of its own.
        height: `${Math.ceil(layout.height) + 1}px`,
        margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' },
        printBackground: options.background ?? true,
      });
    } finally {
      await unhide();
    }
    const bytes = slicePdf(
      tall,
      { ...geometry, height: layout.height, keep },
      fields,
      options.outline ? layout.headings : null,
    );
    return {
      bytes,
      pageCount: keep.length,
      width: Math.round(size.width),
      height: Math.round(size.height),
      fields: fields.filter((field) => field.editable),
      notices,
    };
  } finally {
    await restore();
  }
}

async function nativePdf(
  page: Page,
  options: PdfOptions,
): Promise<Omit<PdfDocument, 'fields' | 'notices'>> {
  const { width, height } = await paperDimensionsOf(page, options);
  const margin = marginsOf(options.margin);
  const header = options.header ?? '';
  const footer = options.footer ?? '';
  // A Buffer, whose slice() shares its bytes: copied into the plain Uint8Array this returns.
  const bytes = new Uint8Array(
    await page.pdf({
      width: cssLength(width),
      height: cssLength(height),
      margin: {
        top: cssLength(margin.top),
        right: cssLength(margin.right),
        bottom: cssLength(margin.bottom),
        left: cssLength(margin.left),
      },
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

// The layout's controls as fields on their pages, named; a notice names those left printed.
function formFields(layout: PageLayout, geometry: PaperGeometry, notices: string[]): PdfField[] {
  const fields = nameFields(placeFields(layout.fields, geometry));
  const printed = fields.filter((field) => !field.editable).map((field) => field.name);
  if (printed.length) {
    notices.push(
      `forms: ${printed.join(', ')} printed, not fillable: a PDF's built-in font writes Latin script only`,
    );
  }
  return fields;
}

// The controls whose own drawing a field replaces: all but buttons, which stay as they print.
function hiddenIndices(fields: PdfField[]): number[] {
  return fields.flatMap((field, index) =>
    field.editable && field.kind !== 'submit' && field.kind !== 'reset' ? [index] : [],
  );
}

/**
 * The pages, from 0, that print-dialog ranges such as `1-3, 5` keep of `count`, in order, each
 * once. Throws when they keep none.
 *
 * ```ts
 * import { keptPages } from './pdf.ts';
 *
 * keptPages('2-3, 1, 3', 4); // [0, 1, 2]
 * keptPages('3-9', 4); // [2, 3]
 * ```
 */
export function keptPages(ranges: string, count: number): number[] {
  const kept = new Set<number>();
  for (const range of ranges.split(',')) {
    const [first, last = first] = range.split('-').map((page) => Number(page.trim()));
    for (let page = Math.max(first, 1); page <= Math.min(last, count); page++) kept.add(page - 1);
  }
  if (!kept.size) throw new RangeError(`pageRanges ${ranges}: the PDF has ${count} pages`);
  return [...kept].sort((a, b) => a - b);
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
    const margin = pixelMargins(options.margin);
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

function pixelMargins(
  margin: PdfOptions['margin'],
): Record<'top' | 'right' | 'bottom' | 'left', number> {
  const sides = marginsOf(margin);
  return {
    top: CSS.toPixels(sides.top),
    right: CSS.toPixels(sides.right),
    bottom: CSS.toPixels(sides.bottom),
    left: CSS.toPixels(sides.left),
  };
}

function cssLength(length: string | number): string {
  return typeof length === 'number' ? `${length}px` : length;
}

// Screenshots on pages: page-high slices of the page as the screen lays it out, each filling the
// space inside the margins, broken where a printer would (between lines, not through them), with
// its form controls made fields over them.
async function rasterPdf(
  page: Page,
  options: PdfOptions,
  document: { title: string; quality: number },
): Promise<PdfDocument> {
  const paper = await paperDimensionsOf(page, options);
  const margin = pixelMargins(options.margin);
  const pageWidth = CSS.toPixels(paper.width);
  const pageHeight = CSS.toPixels(paper.height);
  const inner = {
    width: pageWidth - margin.left - margin.right,
    height: pageHeight - margin.top - margin.bottom,
  };
  const layout = await readLayout(page);
  // CSS pixels of paper per CSS pixel of the page: the page's width fills the paper's.
  const scale = inner.width / layout.width;
  const geometry: PaperGeometry = {
    starts: [0],
    pageHeight: Math.max(1, inner.height / scale),
    paper: { width: pageWidth, height: pageHeight },
    margin,
    scale,
  };
  geometry.starts = pageBreaks(layout.height, geometry.pageHeight, layout.blocks, layout.forced);
  const notices: string[] = [];
  const fields = options.forms === false ? [] : formFields(layout, geometry, notices);
  const unhide = await hideFields(page, hiddenIndices(fields));
  const images: PdfImage[] = [];
  // Taken off again after: the page's stills, made after the PDF, keep their background.
  const noBackground =
    (options.background ?? true)
      ? null
      : await page.addStyleTag({ content: 'html, body { background: #fff !important; }' });
  try {
    for (const [index, top] of geometry.starts.entries()) {
      const end = Math.min(geometry.starts[index + 1] ?? layout.height, top + geometry.pageHeight);
      const jpeg = await page.screenshot({
        type: 'jpeg',
        quality: document.quality,
        fullPage: true,
        clip: { x: 0, y: top, width: layout.width, height: Math.max(1, end - top) },
      });
      const pixels = JPEG.getDimensions(jpeg);
      images.push({
        jpeg,
        pixels,
        page: { width: pageWidth, height: pageHeight },
        at: {
          x: margin.left,
          y: margin.top,
          width: inner.width,
          height: (inner.width * pixels.height) / pixels.width,
        },
      });
    }
  } finally {
    await unhide();
    await noBackground?.evaluate((style: { remove(): void }) => style.remove());
  }
  return {
    bytes: fillPdf(encode(images, { title: document.title }), fields),
    pageCount: images.length,
    width: Math.round(pageWidth),
    height: Math.round(pageHeight),
    fields: fields.filter((field) => field.editable),
    notices,
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
 * How many pages a PDF has: its page tree's count, read through its cross-reference tables; or,
 * when those are streams this reader leaves alone, its page objects.
 *
 * ```ts
 * import { getTotalPageCount, encode } from './pdf.ts';
 *
 * getTotalPageCount(encode([], { title: 'x' })); // 0
 * ```
 */
export function getTotalPageCount(pdf: Uint8Array): number {
  try {
    const file = openPdf(pdf);
    const catalog = readObject(file, (file.trailer.get('Root') as { ref: number }).ref);
    const pages = resolve(file, (catalog as Map<string, PdfValue>).get('Pages'));
    return Number((pages as Map<string, PdfValue>).get('Count'));
  } catch {
    const text = new TextDecoder('latin1').decode(pdf);
    return (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
  }
}

/**
 * Writes a PDF of `page` where it ended to `output`, made as {@link fromPage} makes it, titled
 * after the page, or `name` when it has none. `notices` say what the file was written without,
 * such as a form field left printed rather than fillable.
 *
 * ```ts
 * import * as PDF from './pdf.ts';
 * import type { Output } from './outputs.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live page.
 * async function print(page: Page, output: Output) {
 *   const { file } = await PDF.record(page, output, { paper: 'A4' }, 'vector', 'home', { quality: 90 });
 *   return file.frames;
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
): Promise<{ file: RecordedFile; notices: string[] }> {
  const title = (await page.title().catch(() => '')) || name;
  const { bytes, width, height, pageCount, notices } = await fromPage(page, options, mode, {
    title,
    quality,
  });
  return {
    file: await Outputs.write(output, bytes, { width, height, frames: pageCount }),
    notices,
  };
}
