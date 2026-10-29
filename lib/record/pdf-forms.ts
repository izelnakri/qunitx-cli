import {
  appendObjects,
  isRef,
  openPdf,
  readObject,
  resolve,
  writeValue,
  type PdfFile,
  type PdfValue,
} from './pdf-edit.ts';
import { fieldObjects, pdfText, type PaperGeometry, type PdfField } from './pdf-fields.ts';

/**
 * How one tall printed page is cut into the pages of paper a document is printed on: where each
 * page starts, how much of the layout it holds and how big it is ({@link PaperGeometry}), the
 * layout's full height, and which pages to keep, in order, from 0.
 *
 * ```ts
 * const slicing: Slicing = {
 *   starts: [0, 1000], pageHeight: 1000, height: 1800, keep: [0, 1],
 *   paper: { width: 794, height: 1123 }, margin: { top: 48, left: 48 }, scale: 0.7,
 * };
 * ```
 */
export interface Slicing extends PaperGeometry {
  /** The layout's full height. */
  height: number;
  /** The pages to keep, from 0, in order: all, or a page range's. */
  keep: number[];
}

const POINT = 0.75;
// Catalog entries that point into the tall page, which no page shows any more.
const STALE = ['Pages', 'StructTreeRoot', 'MarkInfo', 'Outlines', 'Dests', 'AcroForm', 'PageMode'];

/**
 * A PDF of one tall page, as Chromium prints a whole layout, made into pages of paper as `slicing`
 * cuts it: each page shows its part of the tall one, clipped, scaled and placed inside its
 * margins — the drawing itself shared, not copied. Its links are moved onto the pages that show
 * them, and `fields` are added as form fields. `headings` make its outline, when given.
 *
 * ```ts
 * import { slicePdf } from './pdf-forms.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: needs a page Chromium printed.
 * async function twoPages(page: Page) {
 *   const tall = await page.pdf({ width: '600px', height: '2000px' });
 *   const slicing = { starts: [0, 1000], pageHeight: 1000, height: 2000, keep: [0, 1],
 *     paper: { width: 600, height: 1000 }, margin: { top: 0, left: 0 }, scale: 1 };
 *   return slicePdf(tall, slicing, [], null);
 * }
 * ```
 */
export function slicePdf(
  pdf: Uint8Array,
  slicing: Slicing,
  fields: PdfField[],
  headings: { level: number; text: string; top: number }[] | null,
): Uint8Array {
  const file = openPdf(pdf);
  const rootId = (file.trailer.get('Root') as { ref: number }).ref;
  const catalog = readObject(file, rootId) as Map<string, PdfValue>;
  const sourceRef = firstPage(file, catalog.get('Pages'));
  const source = readObject(file, sourceRef) as Map<string, PdfValue>;
  const box = (resolve(file, source.get('MediaBox')) as number[]).map(Number);
  const tall = box[3] - box[1];
  const { starts, pageHeight, paper, margin, scale, height, keep } = slicing;
  const paperHeight = paper.height * POINT;

  let next = file.size;
  const id = () => next++;
  const objects: { id: number; body: string }[] = [];
  const pagesId = id();
  const pageIds = keep.map(() => id());
  const pageRef = (index: number) => `${pageIds[index]} 0 R`;
  const close = id();
  objects.push(stream(close, 'Q'));
  // Which kept page shows the point `top` points down the tall page, and where on it.
  const locate = (top: number): { page: number; y: number } | null => {
    const slice = Math.max(
      0,
      starts.findLastIndex((start) => start * POINT <= top + 0.5),
    );
    const page = keep.indexOf(slice);
    if (page < 0) return null;
    return { page, y: paperHeight - margin.top * POINT - scale * (top - starts[slice] * POINT) };
  };
  const x = (value: number) => margin.left * POINT + scale * (value - box[0]);
  const destination = (value: PdfValue): PdfValue | null => {
    const array = resolve(file, value);
    if (!Array.isArray(array) || !isRef(array[0]) || array[0].ref !== sourceRef) return null;
    const [, kind, left, top, ...rest] = array;
    const at = locate(tall - (typeof top === 'number' ? top - box[1] : tall));
    if (!at) return null;
    return [
      { ref: pageIds[at.page] },
      kind,
      typeof left === 'number' ? x(left) : left,
      at.y,
      ...rest,
    ];
  };

  const annots = new Map<number, number[]>();
  const annotate = (page: number, annot: number) =>
    annots.set(page, [...(annots.get(page) ?? []), annot]);
  for (const entry of (resolve(file, source.get('Annots')) as PdfValue[] | null) ?? []) {
    const annot = new Map(resolve(file, entry) as Map<string, PdfValue>);
    if ((annot.get('Subtype') as { name: string } | undefined)?.name !== 'Link') continue;
    const [left, bottom, right, top] = (annot.get('Rect') as number[]).map(Number);
    const at = locate(tall - (top - box[1]));
    if (!at) continue;
    const linked = annot.has('Dest') ? destination(annot.get('Dest')!) : null;
    if (annot.has('Dest') && Array.isArray(resolve(file, annot.get('Dest')))) {
      if (!linked) continue;
      annot.set('Dest', linked);
    }
    for (const key of ['StructParent', 'P', 'Parent']) annot.delete(key);
    annot.set('Rect', [x(left), at.y - scale * (top - bottom), x(right), at.y]);
    annot.set('P', { ref: pageIds[at.page] });
    const annotId = id();
    objects.push({ id: annotId, body: writeValue(annot) });
    annotate(at.page, annotId);
  }

  const updated = new Map([...catalog].filter(([key]) => !STALE.includes(key)));
  updated.set('Pages', { ref: pagesId });
  const dests = resolve(file, catalog.get('Dests'));
  if (dests instanceof Map) {
    const moved = new Map<string, PdfValue>();
    for (const [name, value] of dests) {
      const target = resolve(file, value);
      const mapped = destination(target instanceof Map ? (target.get('D') ?? null) : target);
      if (mapped) moved.set(name, mapped);
    }
    const destsId = id();
    objects.push({ id: destsId, body: writeValue(moved) });
    updated.set('Dests', { ref: destsId });
  }
  if (headings?.length) {
    const outline = outlineObjects(headings, id, (top) => {
      const at = locate(top * POINT);
      return (
        at &&
        `[${pageRef(at.page)} /XYZ ${+(margin.left * POINT).toFixed(2)} ${+at.y.toFixed(2)} null]`
      );
    });
    objects.push(...outline.objects);
    updated.set('Outlines', { ref: outline.id });
    updated.set('PageMode', { name: 'UseOutlines' });
  }
  const form = formObjects(fields, id, pageRef);
  objects.push(...form.objects);
  for (const [page, widgets] of form.annots) for (const widget of widgets) annotate(page, widget);
  if (form.acroForm) updated.set('AcroForm', { ref: form.acroForm });

  const resources = writeValue(source.get('Resources') ?? new Map());
  const contents = [source.get('Contents')].flat().map((entry) => writeValue(entry ?? null));
  const width = paper.width * POINT;
  keep.forEach((slice, index) => {
    const top = starts[slice] * POINT;
    const end = Math.min(
      slice + 1 < starts.length ? starts[slice + 1] : height,
      starts[slice] + pageHeight,
    );
    const shown = (end - starts[slice]) * POINT * scale;
    const offset = paperHeight - margin.top * POINT - scale * (tall - top);
    const open = id();
    const clip = `${n(margin.left * POINT)} ${n(paperHeight - margin.top * POINT - shown)} ${n(scale * (box[2] - box[0]))} ${n(shown)}`;
    objects.push(
      stream(
        open,
        `q ${clip} re W n ${n(scale)} 0 0 ${n(scale)} ${n(margin.left * POINT - scale * box[0])} ${n(offset - scale * box[1])} cm`,
      ),
    );
    const widgets = annots.get(index);
    objects.push({
      id: pageIds[index],
      body:
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(width)} ${n(paperHeight)}] /Resources ${resources}` +
        ` /Contents [${open} 0 R ${contents.join(' ')} ${close} 0 R]` +
        (widgets ? ` /Annots [${widgets.map((widget) => `${widget} 0 R`).join(' ')}]` : '') +
        ' >>',
    });
  });
  objects.push({
    id: pagesId,
    body: `<< /Type /Pages /Kids [${pageIds.map((page) => `${page} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
  });
  objects.push({ id: rootId, body: writeValue(updated) });
  return appendObjects(file, objects);
}

/**
 * `fields` added to a PDF whose pages already show them, as `PDF.encode` lays screenshots out: the
 * pages get their widgets, the catalog its form.
 *
 * ```ts
 * import { fillPdf } from './pdf-forms.ts';
 * import * as PDF from './pdf.ts';
 *
 * const pdf = PDF.encode([], { title: 'Empty' });
 * fillPdf(pdf, []) === pdf; // true — nothing to add
 * ```
 */
export function fillPdf(pdf: Uint8Array, fields: PdfField[]): Uint8Array {
  if (!fields.some((field) => field.editable)) return pdf;
  const file = openPdf(pdf);
  const rootId = (file.trailer.get('Root') as { ref: number }).ref;
  const catalog = readObject(file, rootId) as Map<string, PdfValue>;
  const pages = leaves(file, catalog.get('Pages'));
  let next = file.size;
  const objects: { id: number; body: string }[] = [];
  const form = formObjects(
    fields,
    () => next++,
    (page) => `${pages[page]} 0 R`,
  );
  objects.push(...form.objects);
  for (const [page, widgets] of form.annots) {
    const dict = new Map(readObject(file, pages[page]) as Map<string, PdfValue>);
    const existing = (resolve(file, dict.get('Annots')) as PdfValue[] | null) ?? [];
    dict.set('Annots', [...existing, ...widgets.map((widget) => ({ ref: widget }))]);
    objects.push({ id: pages[page], body: writeValue(dict) });
  }
  const updated = new Map(catalog);
  updated.set('AcroForm', { ref: form.acroForm! });
  objects.push({ id: rootId, body: writeValue(updated) });
  return appendObjects(file, objects);
}

// The fields' objects, the form that lists them, and its two fonts: Helvetica in Windows-1252 for
// text, ZapfDingbats for a viewer that redraws a check box itself.
function formObjects(
  fields: PdfField[],
  id: () => number,
  pageRef: (page: number) => string,
): {
  objects: { id: number; body: string }[];
  annots: Map<number, number[]>;
  acroForm: number | null;
} {
  if (!fields.some((field) => field.editable))
    return { objects: [], annots: new Map(), acroForm: null };
  const helvetica = id();
  const zapf = id();
  const built = fieldObjects(fields, id, pageRef, { helvetica, zapf });
  const acroForm = id();
  return {
    objects: [
      {
        id: helvetica,
        body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      },
      { id: zapf, body: '<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>' },
      ...built.objects,
      {
        id: acroForm,
        body: `<< /Fields [${built.fields.map((field) => `${field} 0 R`).join(' ')}] /DR << /Font << /Helv ${helvetica} 0 R /ZaDb ${zapf} 0 R >> >> /DA (/Helv 0 Tf 0 g) >>`,
      },
    ],
    annots: built.annots,
    acroForm,
  };
}

// An outline of `headings`, nested by level, every entry open: a heading on no kept page is left
// out, its subheadings moving up to its parent.
function outlineObjects(
  headings: { level: number; text: string; top: number }[],
  id: () => number,
  destination: (top: number) => string | null,
): { id: number; objects: { id: number; body: string }[] } {
  interface Entry {
    id: number;
    title: string;
    dest: string;
    children: Entry[];
  }
  const root: Entry = { id: id(), title: '', dest: '', children: [] };
  const stack: { level: number; entry: Entry }[] = [{ level: 0, entry: root }];
  for (const heading of headings) {
    const dest = destination(heading.top);
    if (!dest) continue;
    // Back to the nearest heading above this one's level: the root's 0 always is.
    stack.splice(stack.findLastIndex((frame) => frame.level < heading.level) + 1);
    const entry = { id: id(), title: heading.text, dest, children: [] };
    stack.at(-1)!.entry.children.push(entry);
    stack.push({ level: heading.level, entry });
  }
  const objects: { id: number; body: string }[] = [];
  const count = (entry: Entry): number =>
    entry.children.reduce((total, child) => total + 1 + count(child), 0);
  const links = (entry: Entry) =>
    entry.children.length
      ? ` /First ${entry.children[0].id} 0 R /Last ${entry.children.at(-1)!.id} 0 R /Count ${count(entry)}`
      : '';
  const emit = (entry: Entry, parent: Entry) => {
    const siblings = parent.children;
    const at = siblings.indexOf(entry);
    objects.push({
      id: entry.id,
      body:
        `<< /Title ${pdfText(entry.title)} /Parent ${parent.id} 0 R /Dest ${entry.dest}` +
        (at > 0 ? ` /Prev ${siblings[at - 1].id} 0 R` : '') +
        (at + 1 < siblings.length ? ` /Next ${siblings[at + 1].id} 0 R` : '') +
        `${links(entry)} >>`,
    });
    for (const child of entry.children) emit(child, entry);
  };
  objects.push({ id: root.id, body: `<< /Type /Outlines${links(root)} >>` });
  for (const child of root.children) emit(child, root);
  return { id: root.id, objects };
}

function firstPage(file: PdfFile, node: PdfValue | undefined): number {
  return leaves(file, node)[0];
}

// The page objects under a page tree node, in order.
function leaves(file: PdfFile, node: PdfValue | undefined): number[] {
  if (!isRef(node)) return [];
  const dict = readObject(file, node.ref) as Map<string, PdfValue>;
  const kids = resolve(file, dict.get('Kids'));
  return Array.isArray(kids) ? kids.flatMap((kid) => leaves(file, kid)) : [node.ref];
}

function stream(id: number, content: string): { id: number; body: string } {
  return { id, body: `<< /Length ${content.length} >>\nstream\n${content}\nendstream` };
}

function n(value: number): string {
  return String(+value.toFixed(3));
}
