// Reads what a test needs to know about a PDF — Chromium's, the raster writer's, or either with
// form fields appended as an update — without a PDF library: its pages' sizes, its title, whether
// its text is text (fonts) or pictures (JPEGs), its form fields, and, where its cross-reference
// tables are plain tables, whether every offset in each lands on its object.

/**
 * What a PDF holds, as far as tests look.
 *
 * ```ts
 * const parsed: ParsedPdf = {
 *   pages: [[0, 0, 612, 792]], title: 'Home', fonts: true, jpegs: 0, xrefValid: null, fields: [], links: [], outline: [],
 * };
 * ```
 */
export interface ParsedPdf {
  /** Each page's MediaBox, in points, in document order. */
  pages: number[][];
  title: string | null;
  /** Whether any font is used: text kept as text. */
  fonts: boolean;
  /** JPEG images (DCTDecode streams). */
  jpegs: number;
  /** For classic `xref` tables: whether each entry of each points at its object. Null without. */
  xrefValid: boolean | null;
  /** Each form field's widgets: a radio group's name once per button. */
  fields: ParsedField[];
  /** Each link: its page, its rectangle, and where it goes (a URL, or a named destination). */
  links: { page: number; rect: number[]; to: string }[];
  /** The outline's titles, depth-first. */
  outline: string[];
}

/**
 * One widget of a form field.
 *
 * ```ts
 * const field: ParsedField = { name: 'email', type: 'Tx', value: 'ada@example.com', flags: 0, page: 0, rect: [10, 700, 200, 720], states: [] };
 * ```
 */
export interface ParsedField {
  name: string;
  /** `Tx` text, `Btn` button, `Ch` choice. */
  type: string;
  /** Text as text; a name (a check box's state) without its `/`; a list joined by `,`. */
  value: string | null;
  flags: number;
  /** From 0. */
  page: number;
  rect: number[];
  /** A check box's or radio button's appearance states. */
  states: string[];
}

/**
 * Parses `bytes` as far as {@link ParsedPdf} goes: the objects as last written, from its root.
 *
 * ```ts
 * import { parsePdf } from './pdf-parse.ts';
 *
 * parsePdf(new TextEncoder().encode('%PDF-1.4\n')).pages; // []
 * ```
 */
export function parsePdf(bytes: Uint8Array): ParsedPdf {
  const text = new TextDecoder('latin1').decode(bytes);
  const objects = new Map<number, string>();
  for (const match of text.matchAll(/(?:^|\s)(\d+) 0 obj\b([^]*?)\bendobj/g)) {
    objects.set(Number(match[1]), match[2]);
  }
  const ref = (body: string | undefined, key: string) => {
    const found = new RegExp(`/${key}\\s+(\\d+) 0 R`).exec(body ?? '');
    return found ? Number(found[1]) : null;
  };
  const root = [...text.matchAll(/\/Root\s+(\d+) 0 R/g)].at(-1);
  const catalog = root ? objects.get(Number(root[1])) : undefined;
  const pageIds = leaves(objects, ref(catalog, 'Pages'));
  const pages = pageIds.map((id) =>
    numbers(/\/MediaBox\s*\[([^\]]+)\]/.exec(objects.get(id)!)![1]),
  );
  const info = [...text.matchAll(/\/Info\s+(\d+) 0 R/g)].at(-1);
  const raw =
    info &&
    /\/Title\s*(\((?:\\.|[^\\)])*\)|<[0-9a-fA-F]*>)/.exec(objects.get(Number(info[1])) ?? '')?.[1];

  const fields: ParsedField[] = [];
  const links: ParsedPdf['links'] = [];
  pageIds.forEach((pageId, page) => {
    const annots = /\/Annots\s*\[([^\]]*)\]/.exec(objects.get(pageId)!)?.[1] ?? '';
    for (const [, id] of annots.matchAll(/(\d+) 0 R/g)) {
      const body = objects.get(Number(id))!;
      const rect = numbers(/\/Rect\s*\[([^\]]+)\]/.exec(body)![1]);
      if (/\/Subtype\s*\/Link/.test(body)) {
        const uri = /\/URI\s*(\((?:\\.|[^\\)])*\))/.exec(body)?.[1];
        const dest = /\/Dest\s*\/([^\s/>\]]+)/.exec(body)?.[1];
        links.push({ page, rect, to: uri ? decodeString(uri) : `#${dest}` });
        continue;
      }
      const parent = objects.get(ref(body, 'Parent') ?? -1);
      const field = parent ?? body;
      const value =
        /\/V\s*(\((?:\\.|[^\\)])*\)|<[0-9a-fA-F]*>|\/[^\s/>\]]*|\[[^\]]*\])/.exec(field)?.[1] ??
        null;
      const states = /\/AP\s*<<\s*\/N\s*<<([^]*?)>>/.exec(body)?.[1];
      fields.push({
        name: decodeString(/\/T\s*(\((?:\\.|[^\\)])*\)|<[0-9a-fA-F]*>)/.exec(field)![1]),
        type: /\/FT\s*\/(\w+)/.exec(field)![1],
        value: value === null ? null : valueOf(value),
        flags: Number(/\/Ff\s+(\d+)/.exec(field)?.[1] ?? 0),
        page,
        rect,
        states: states
          ? [...states.matchAll(/\/([^\s/]+)\s+\d+ 0 R/g)].map((state) => state[1])
          : [],
      });
    }
  });
  const outline: string[] = [];
  const walk = (id: number | null) => {
    for (let at = id; at !== null; at = ref(objects.get(at), 'Next')) {
      const body = objects.get(at)!;
      outline.push(decodeString(/\/Title\s*(\((?:\\.|[^\\)])*\)|<[0-9a-fA-F]*>)/.exec(body)![1]));
      walk(ref(body, 'First'));
    }
  };
  walk(ref(objects.get(ref(catalog, 'Outlines') ?? -1), 'First'));
  return {
    pages,
    title: raw ? decodeString(raw) : null,
    fonts: /\/Font\b/.test(text),
    jpegs: (text.match(/\/DCTDecode/g) ?? []).length,
    xrefValid: checkXref(text),
    fields,
    links,
    outline,
  };
}

function leaves(objects: Map<number, string>, id: number | null): number[] {
  if (id === null) return [];
  const body = objects.get(id) ?? '';
  const kids = /\/Kids\s*\[([^\]]*)\]/.exec(body);
  if (!kids) return [id];
  return [...kids[1].matchAll(/(\d+) 0 R/g)].flatMap((kid) => leaves(objects, Number(kid[1])));
}

function numbers(list: string): number[] {
  return list.trim().split(/\s+/).map(Number);
}

function valueOf(raw: string): string {
  if (raw.startsWith('/')) return raw.slice(1);
  if (raw.startsWith('[')) {
    return [...raw.matchAll(/\((?:\\.|[^\\)])*\)|<[0-9a-fA-F]*>/g)]
      .map((item) => decodeString(item[0]))
      .join(',');
  }
  return decodeString(raw);
}

function decodeString(raw: string): string {
  if (raw.startsWith('(')) return raw.slice(1, -1).replace(/\\([\\()])/g, '$1');
  const hex = raw.slice(1, -1);
  const units: number[] = [];
  for (let at = 0; at < hex.length; at += 4) units.push(parseInt(hex.slice(at, at + 4), 16));
  return String.fromCharCode(...(units[0] === 0xfeff ? units.slice(1) : units));
}

// Every table from the last back through each `/Prev`: each entry in use starts its object.
function checkXref(text: string): boolean | null {
  const start = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
  if (!start) return null;
  for (let at: number | null = Number(start[1]); at !== null;) {
    if (!text.startsWith('xref', at)) return null;
    const table = /xref\s+([^]*?)trailer\s*<<([^]*?)startxref/.exec(text.slice(at))!;
    const words = table[1].trim().split(/\s+/);
    for (let index = 0; index < words.length;) {
      const first = Number(words[index]);
      const count = Number(words[index + 1]);
      for (let entry = 0; entry < count; entry++) {
        const [offset, , kind] = words.slice(index + 2 + entry * 3, index + 5 + entry * 3);
        if (kind === 'n' && !text.startsWith(`${first + entry} 0 obj`, Number(offset)))
          return false;
      }
      index += 2 + count * 3;
    }
    const previous = /\/Prev\s+(\d+)/.exec(table[2]);
    at = previous ? Number(previous[1]) : null;
  }
  return true;
}
