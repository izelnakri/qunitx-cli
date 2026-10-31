import type { LaidOutField } from './pdf-layout.ts';

/**
 * A form field of a printed PDF: the control it was made from, the page it is on (from 0), where
 * on it — `[left, bottom, right, top]` in PDF points from the page's bottom-left — its unique name
 * in the PDF, and whether it is editable or stays as the page printed it.
 *
 * ```ts
 * const field: PdfField = {
 *   kind: 'text', name: 'email', value: 'ada@example.com', checked: false, options: [], multiple: false, label: 'Email',
 *   required: false, readOnly: false, maxLength: null, password: false, action: null,
 *   page: 0, rect: [15, 700, 195, 724], fontSize: 12, color: [0, 0, 0], align: 'left',
 *   padding: { left: 6, right: 6, top: 4.5 }, editable: true,
 * };
 * ```
 */
export interface PdfField extends Omit<LaidOutField, 'rect' | 'font' | 'padding'> {
  /** Its page, from 0. */
  page: number;
  /** `[left, bottom, right, top]` in points from the page's bottom-left. */
  rect: [number, number, number, number];
  /** Its text's size, in points. */
  fontSize: number;
  /** Its text's color, as 0–1 RGB. */
  color: [number, number, number];
  /** Its text's alignment. */
  align: 'left' | 'center' | 'right';
  /** Where its text starts from each side, in points. */
  padding: { left: number; right: number; top: number };
  /**
   * False when the PDF's own font cannot write what it shows (Latin script only): it is left as
   * the page printed it, not editable.
   */
  editable: boolean;
}

/**
 * How a layout is laid onto paper: where each page starts in the layout, how much of it a page
 * holds, the paper's size and margins, and the scale it is printed at — layout lengths are CSS
 * pixels, the rest CSS pixels of paper.
 *
 * ```ts
 * const geometry: PaperGeometry = {
 *   starts: [0, 1000], pageHeight: 1000,
 *   paper: { width: 794, height: 1123 }, margin: { top: 48, left: 48 }, scale: 0.7,
 * };
 * ```
 */
export interface PaperGeometry {
  /** Where each page starts in the layout, top down. */
  starts: number[];
  /** The most of the layout a page holds. */
  pageHeight: number;
  /** The paper's size. */
  paper: { width: number; height: number };
  /** Its top and left margins. */
  margin: { top: number; left: number };
  /** CSS pixels of paper per CSS pixel of layout. */
  scale: number;
}

const POINT = 0.75;

/**
 * Puts each laid-out field on its page: the page whose part of the layout its top falls in, its
 * rectangle in that page's PDF points (cut at the page's end if it is taller than a page), and its
 * text sized as printed. Names and editability are for {@link nameFields}.
 *
 * ```ts
 * import { placeFields } from './pdf-fields.ts';
 *
 * const geometry = { starts: [0, 100], pageHeight: 100, paper: { width: 200, height: 100 }, margin: { top: 0, left: 0 }, scale: 1 };
 * const field = {
 *   kind: 'text' as const, name: 'a', value: '', checked: false, options: [], multiple: false, label: '', required: false,
 *   readOnly: false, maxLength: null, password: false, action: null,
 *   rect: { x: 0, y: 120, width: 40, height: 20 }, font: { size: 16, color: [0, 0, 0] as [number, number, number], align: 'left' as const },
 *   padding: { left: 0, right: 0, top: 0 },
 * };
 * const [placed] = placeFields([field], geometry);
 * [placed.page, placed.rect]; // [1, [0, 45, 30, 60]]
 * ```
 */
export function placeFields(
  fields: LaidOutField[],
  geometry: PaperGeometry,
): Omit<PdfField, 'editable'>[] {
  const { starts, pageHeight, paper, margin, scale } = geometry;
  return fields.map(({ rect, font, padding, ...field }) => {
    const page = Math.max(
      0,
      starts.findLastIndex((start) => start <= rect.y + 0.5),
    );
    const end = page + 1 < starts.length ? starts[page + 1] : starts[page] + pageHeight;
    const height = Math.max(1, Math.min(rect.height, end - rect.y));
    const left = margin.left + scale * rect.x;
    const top = margin.top + scale * (rect.y - starts[page]);
    const round = (value: number) => Math.round(value * POINT * 100) / 100;
    return {
      ...field,
      page,
      rect: [
        round(left),
        round(paper.height - top - scale * height),
        round(left + scale * rect.width),
        round(paper.height - top),
      ],
      fontSize: round(font.size * scale),
      color: font.color,
      align: font.align,
      padding: {
        left: round(padding.left * scale),
        right: round(padding.right * scale),
        top: round(padding.top * scale),
      },
    };
  });
}

/**
 * Gives every field a name of its own in the PDF, as a PDF needs: radio buttons sharing a name
 * stay one group, check boxes sharing one are told apart by value (`toppings[cheese]`), anything
 * else sharing one is numbered (`item[2]`), and one with no name is named for its kind
 * (`text-3`). A name may not hold a `.`, which in a PDF nests fields; it becomes `_`. Each is
 * also marked editable, or not when the PDF's font cannot write what it shows.
 *
 * ```ts
 * import { nameFields } from './pdf-fields.ts';
 *
 * const base = { checked: false, options: [], multiple: false, label: '', required: false, readOnly: false, maxLength: null,
 *   password: false, action: null, page: 0, rect: [0, 0, 1, 1] as [number, number, number, number], fontSize: 12,
 *   color: [0, 0, 0] as [number, number, number], align: 'left' as const, padding: { left: 0, right: 0, top: 0 } };
 * nameFields([
 *   { ...base, kind: 'text', name: 'item', value: 'a' },
 *   { ...base, kind: 'text', name: 'item', value: 'Иван' },
 *   { ...base, kind: 'text', name: '', value: '' },
 * ]).map((field) => [field.name, field.editable]); // [['item', true], ['item[2]', false], ['text-3', true]]
 * ```
 */
export function nameFields(fields: Omit<PdfField, 'editable'>[]): PdfField[] {
  const taken = new Set<string>();
  const groups = new Map<string, string>();
  const boxes = new Map<string, number>();
  for (const field of fields) {
    if (field.kind === 'checkbox' && field.name) {
      boxes.set(field.name, (boxes.get(field.name) ?? 0) + 1);
    }
  }
  // `base` when no field has it yet, else the first of `base[2]`, `base[3]`… none has.
  const claim = (base: string) => {
    let name = base;
    for (let count = 2; taken.has(name); count++) name = `${base}[${count}]`;
    taken.add(name);
    return name;
  };
  return fields.map((field, index) => {
    const base = (field.name || `${field.kind}-${index + 1}`).replace(/\./g, '_');
    let name: string;
    if (field.kind === 'radio') {
      name = groups.get(base) ?? claim(base);
      groups.set(base, name);
    } else if (field.kind === 'checkbox' && (boxes.get(field.name) ?? 0) > 1) {
      name = claim(`${base}[${field.value.replace(/\./g, '_')}]`);
    } else {
      name = claim(base);
    }
    return { ...field, name, editable: drawable(field) };
  });
}

// Whether the PDF's own font can write all a field shows: its text, or a select's labels.
function drawable(field: Omit<PdfField, 'editable'>): boolean {
  if (
    field.kind === 'submit' ||
    field.kind === 'reset' ||
    field.kind === 'checkbox' ||
    field.kind === 'radio'
  ) {
    return true;
  }
  const shown =
    field.kind === 'select' || field.kind === 'list'
      ? field.options.map((option) => option.label)
      : [field.value];
  return shown.every(encodable);
}

// Windows-1252 at 0x80–0x9F, where it differs from Latin-1; the rest of 0xA0–0xFF is Latin-1.
const WIN_ANSI: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  ƒ: 0x83,
  '„': 0x84,
  '…': 0x85,
  '†': 0x86,
  '‡': 0x87,
  ˆ: 0x88,
  '‰': 0x89,
  Š: 0x8a,
  '‹': 0x8b,
  Œ: 0x8c,
  Ž: 0x8e,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '˜': 0x98,
  '™': 0x99,
  š: 0x9a,
  '›': 0x9b,
  œ: 0x9c,
  ž: 0x9e,
  Ÿ: 0x9f,
};

function winAnsi(character: string): number | null {
  const code = character.codePointAt(0)!;
  if ((code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code <= 0xff)) return code;
  return WIN_ANSI[character] ?? null;
}

/**
 * Whether the PDF's built-in Helvetica can write `text`: Latin script, accents and the usual
 * punctuation (Windows-1252), and nothing else.
 *
 * ```ts
 * import { encodable } from './pdf-fields.ts';
 *
 * encodable('Zoë Müller · €120 — “ok”'); // true
 * encodable('山田'); // false
 * ```
 */
export function encodable(text: string): boolean {
  return [...text.replace(/[\n\r\t]/g, ' ')].every((character) => winAnsi(character) !== null);
}

// Helvetica's advance widths, per 1000 of the font size, by Windows-1252 code: enough to wrap and
// align text as a viewer will draw it. Accented letters take their base letter's width.
const WIDTHS: Record<number, number> = Object.fromEntries(
  [
    [32, 278],
    [33, 278],
    [34, 355],
    [35, 556],
    [36, 556],
    [37, 889],
    [38, 667],
    [39, 191],
    [40, 333],
    [41, 333],
    [42, 389],
    [43, 584],
    [44, 278],
    [45, 333],
    [46, 278],
    [47, 278],
    [58, 278],
    [59, 278],
    [60, 584],
    [61, 584],
    [62, 584],
    [63, 556],
    [64, 1015],
    [65, 667],
    [66, 667],
    [67, 722],
    [68, 722],
    [69, 667],
    [70, 611],
    [71, 778],
    [72, 722],
    [73, 278],
    [74, 500],
    [75, 667],
    [76, 556],
    [77, 833],
    [78, 722],
    [79, 778],
    [80, 667],
    [81, 778],
    [82, 722],
    [83, 667],
    [84, 611],
    [85, 722],
    [86, 667],
    [87, 944],
    [88, 667],
    [89, 667],
    [90, 611],
    [91, 278],
    [92, 278],
    [93, 278],
    [94, 469],
    [95, 556],
    [96, 333],
    [97, 556],
    [98, 556],
    [99, 500],
    [100, 556],
    [101, 556],
    [102, 278],
    [103, 556],
    [104, 556],
    [105, 222],
    [106, 222],
    [107, 500],
    [108, 222],
    [109, 833],
    [110, 556],
    [111, 556],
    [112, 556],
    [113, 556],
    [114, 333],
    [115, 500],
    [116, 278],
    [117, 556],
    [118, 500],
    [119, 722],
    [120, 500],
    [121, 500],
    [122, 500],
    [123, 334],
    [124, 260],
    [125, 334],
    [126, 584],
    [0x95, 350],
    [0xc6, 1000],
    [0xe6, 889],
    [0xdf, 611],
    [0xd7, 584],
    [0xf7, 584],
  ].concat(Array.from({ length: 10 }, (_, digit) => [48 + digit, 556])),
);

/**
 * How wide `text` is in Helvetica at `size`, in the same unit as `size`.
 *
 * ```ts
 * import { textWidth } from './pdf-fields.ts';
 *
 * textWidth('Hi', 10); // 9.44
 * ```
 */
export function textWidth(text: string, size: number): number {
  let width = 0;
  for (const character of text) {
    const code = winAnsi(character) ?? 63;
    const base = character.normalize('NFD')[0];
    width += WIDTHS[code] ?? WIDTHS[base.codePointAt(0)!] ?? 556;
  }
  return (width * size) / 1000;
}

/**
 * `text` broken into lines no wider than `width` in Helvetica at `size`: at spaces where it can,
 * through a word only when the word alone is wider. Line breaks in it are kept.
 *
 * ```ts
 * import { wrap } from './pdf-fields.ts';
 *
 * wrap('one two three', 10, 40); // ['one two', 'three']
 * ```
 */
export function wrap(text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size) <= width || !line) {
        // What is too wide even alone is broken where it must be; its last piece carries on.
        const broken = pieces(next, size, width);
        lines.push(...broken.slice(0, -1));
        line = broken.at(-1) as string;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * A PDF text string: plain when ASCII, else UTF-16 with its byte-order mark, which every reader
 * takes — for names, values, labels and titles.
 *
 * ```ts
 * import { pdfText } from './pdf-fields.ts';
 *
 * pdfText('a (b)'); // '(a \\(b\\))'
 * pdfText('é'); // '<feff00e9>'
 * ```
 */
export function pdfText(text: string): string {
  if ([...text].every((character) => character.charCodeAt(0) < 128)) {
    return `(${text
      .replace(/[\\()]/g, (character) => `\\${character}`)
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')})`;
  }
  const units = [...text].flatMap((character) => {
    const code = character.codePointAt(0)!;
    if (code < 0x10000) return [code];
    const value = code - 0x10000;
    return [0xd800 + (value >> 10), 0xdc00 + (value & 0x3ff)];
  });
  return `<feff${units.map((unit) => unit.toString(16).padStart(4, '0')).join('')}>`;
}

/**
 * A PDF name for `text`: anything but plain visible ASCII, and the characters a name cannot hold,
 * written as `#xx` bytes of its UTF-8.
 *
 * ```ts
 * import { pdfName } from './pdf-fields.ts';
 *
 * pdfName('Yes'); // '/Yes'
 * pdfName('a b/é'); // '/a#20b#2F#C3#A9'
 * ```
 */
export function pdfName(text: string): string {
  const bytes = new TextEncoder().encode(text || 'Yes');
  let name = '/';
  for (const byte of bytes) {
    const plain = byte > 0x20 && byte < 0x7f && !'()<>[]{}/%#'.includes(String.fromCharCode(byte));
    name += plain
      ? String.fromCharCode(byte)
      : `#${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return name;
}

// Text for a content stream in the PDF's Helvetica: Windows-1252 bytes, the special ones escaped.
function shownText(text: string): string {
  let shown = '(';
  for (const character of text) {
    const code = winAnsi(character) ?? 63;
    if (character === '(' || character === ')' || character === '\\') shown += `\\${character}`;
    else shown += code < 128 ? character : `\\${code.toString(8).padStart(3, '0')}`;
  }
  return `${shown})`;
}

const FLAGS = {
  readOnly: 1,
  required: 2,
  multiline: 1 << 12,
  password: 1 << 13,
  noToggleToOff: 1 << 14,
  radio: 1 << 15,
  pushButton: 1 << 16,
  combo: 1 << 17,
  multiSelect: 1 << 21,
};

// The fonts every field's appearance and default look name: Helvetica for text, ZapfDingbats for
// the mark a viewer draws when it redraws a check box or radio button itself.
const KAPPA = 0.5523;

/**
 * The PDF objects that make `fields` fillable, ready to write: a field and its widget for each
 * (a radio group is one field with a widget per button), each widget's appearance — its text in
 * Helvetica, a check or a dot drawn as paths — and which page each widget goes on. `id` hands out
 * object numbers; `pageRef` names the page objects; `fonts` names the two font objects.
 *
 * ```ts
 * import { fieldObjects } from './pdf-fields.ts';
 *
 * let next = 100;
 * const built = fieldObjects([], () => next++, (page) => `${page + 1} 0 R`, { helvetica: 10, zapf: 11 });
 * built.fields.length; // 0
 * ```
 */
export function fieldObjects(
  fields: PdfField[],
  id: () => number,
  pageRef: (page: number) => string,
  fonts: { helvetica: number; zapf: number },
): {
  objects: { id: number; body: string }[];
  fields: number[];
  annots: Map<number, number[]>;
} {
  const objects: { id: number; body: string }[] = [];
  const topLevel: number[] = [];
  const annots = new Map<number, number[]>();
  const annotate = (page: number, widget: number) =>
    annots.set(page, [...(annots.get(page) ?? []), widget]);
  const stream = (width: number, height: number, content: string) => {
    const at = id();
    objects.push({
      id: at,
      body: `<< /Type /XObject /Subtype /Form /BBox [0 0 ${width} ${height}] /Resources << /Font << /Helv ${fonts.helvetica} 0 R >> >> /Length ${content.length} >>\nstream\n${content}\nendstream`,
    });
    return at;
  };
  const common = (field: PdfField) =>
    `/Type /Annot /Subtype /Widget /F 4 /Rect [${field.rect.join(' ')}] /P ${pageRef(field.page)}` +
    (field.label ? ` /TU ${pdfText(field.label)}` : '');
  const flags = (field: PdfField, extra = 0) =>
    (field.readOnly ? FLAGS.readOnly : 0) | (field.required ? FLAGS.required : 0) | extra;
  const da = (field: PdfField) => `/DA (/Helv ${field.fontSize} Tf ${field.color.join(' ')} rg)`;

  const groups = new Map<string, PdfField[]>();
  for (const field of fields) {
    if (!field.editable) continue;
    const width = +(field.rect[2] - field.rect[0]).toFixed(2);
    const height = +(field.rect[3] - field.rect[1]).toFixed(2);
    if (field.kind === 'radio') {
      groups.set(field.name, [...(groups.get(field.name) ?? []), field]);
    } else if (field.kind === 'checkbox') {
      const state = pdfName(field.value === 'on' ? 'Yes' : field.value);
      const on = stream(width, height, mark('checkbox', width, height, true));
      const off = stream(width, height, mark('checkbox', width, height, false));
      const at = id();
      objects.push({
        id: at,
        body: `<< ${common(field)} /FT /Btn /T ${pdfText(field.name)} /Ff ${flags(field)} /V ${field.checked ? state : '/Off'} /AS ${field.checked ? state : '/Off'} /DA (/ZaDb 0 Tf 0 g) /MK << /CA (4) >> /AP << /N << ${state} ${on} 0 R /Off ${off} 0 R >> >> >>`,
      });
      topLevel.push(at);
      annotate(field.page, at);
    } else if (field.kind === 'submit' || field.kind === 'reset') {
      // The page's own button stays as it printed: the widget over it only acts.
      if (field.kind === 'submit' && !field.action) continue;
      const action =
        field.kind === 'reset'
          ? '<< /S /ResetForm >>'
          : `<< /S /SubmitForm /F << /FS /URL /F ${pdfText(field.action!.url)} >> /Flags ${4 | (field.action!.method === 'GET' ? 8 : 0)} >>`;
      const look = stream(width, height, '');
      const at = id();
      objects.push({
        id: at,
        body: `<< ${common(field)} /FT /Btn /T ${pdfText(field.name)} /Ff ${FLAGS.pushButton} /A ${action} /AP << /N ${look} 0 R >> >>`,
      });
      topLevel.push(at);
      annotate(field.page, at);
    } else {
      const look = stream(width, height, textLook(field, width, height));
      const at = id();
      let kind = '/FT /Tx';
      let value = `/V ${pdfText(field.value)}`;
      let extra = 0;
      if (field.kind === 'textarea') extra = FLAGS.multiline;
      if (field.password) extra = FLAGS.password;
      if (field.kind === 'select' || field.kind === 'list') {
        const chosen = field.options.filter((option) => option.selected);
        kind = `/FT /Ch /Opt [${field.options.map((option) => `[${pdfText(option.value)} ${pdfText(option.label)}]`).join(' ')}]`;
        value =
          field.kind === 'list'
            ? `/V [${chosen.map((option) => pdfText(option.value)).join(' ')}] /I [${field.options.flatMap((option, index) => (option.selected ? [index] : [])).join(' ')}]`
            : `/V ${pdfText(chosen[0]?.value ?? '')}`;
        extra = field.kind === 'select' ? FLAGS.combo : field.multiple ? FLAGS.multiSelect : 0;
      }
      const length =
        field.maxLength && field.kind !== 'select' && field.kind !== 'list'
          ? ` /MaxLen ${field.maxLength}`
          : '';
      const align = { left: 0, center: 1, right: 2 }[field.align];
      objects.push({
        id: at,
        body: `<< ${common(field)} ${kind} /T ${pdfText(field.name)} /Ff ${flags(field, extra)} ${value}${length} /Q ${align} ${da(field)} /AP << /N ${look} 0 R >> >>`,
      });
      topLevel.push(at);
      annotate(field.page, at);
    }
  }
  for (const [name, buttons] of groups) {
    const parent = id();
    const kids: number[] = [];
    let chosen = '/Off';
    for (const button of buttons) {
      const width = +(button.rect[2] - button.rect[0]).toFixed(2);
      const height = +(button.rect[3] - button.rect[1]).toFixed(2);
      const state = pdfName(button.value === 'on' ? `Choice${kids.length + 1}` : button.value);
      if (button.checked) chosen = state;
      const on = stream(width, height, mark('radio', width, height, true));
      const off = stream(width, height, mark('radio', width, height, false));
      const at = id();
      objects.push({
        id: at,
        body: `<< ${common(button)} /Parent ${parent} 0 R /AS ${button.checked ? state : '/Off'} /MK << /CA (l) >> /AP << /N << ${state} ${on} 0 R /Off ${off} 0 R >> >> >>`,
      });
      kids.push(at);
      annotate(button.page, at);
    }
    const first = buttons[0];
    objects.push({
      id: parent,
      body: `<< /FT /Btn /T ${pdfText(name)} /Ff ${flags(first, FLAGS.radio | FLAGS.noToggleToOff)} /V ${chosen} /DA (/ZaDb 0 Tf 0 g) /Kids [${kids.map((kid) => `${kid} 0 R`).join(' ')}] >>`,
    });
    topLevel.push(parent);
  }
  return { objects, fields: topLevel, annots };
}

// What a text, select or list field shows until it is edited: its text in Helvetica, as the page
// laid it out, clipped to the field.
function textLook(field: PdfField, width: number, height: number): string {
  const size = field.fontSize;
  const [red, green, blue] = field.color;
  const inner = Math.max(1, width - field.padding.left - field.padding.right);
  const x = (text: string) =>
    field.align === 'center'
      ? (width - textWidth(text, size)) / 2
      : field.align === 'right'
        ? width - field.padding.right - textWidth(text, size)
        : field.padding.left;
  const line = (text: string, baseline: number) =>
    `BT /Helv ${size} Tf ${red} ${green} ${blue} rg ${x(text).toFixed(2)} ${baseline.toFixed(2)} Td ${shownText(text)} Tj ET`;
  let body = '';
  if (field.kind === 'list') {
    const row = size * 1.25;
    field.options.forEach((option, index) => {
      const top = height - field.padding.top - row * index;
      if (option.selected)
        body += `0.80 0.86 0.98 rg 1 ${(top - row).toFixed(2)} ${width - 2} ${row.toFixed(2)} re f\n`;
      body += `${line(option.label, top - row + size * 0.3)}\n`;
    });
  } else if (field.kind === 'textarea') {
    const leading = size * 1.2;
    wrap(field.value, size, inner).forEach((text, index) => {
      body += `${line(text, height - field.padding.top - size * 0.9 - leading * index)}\n`;
    });
  } else {
    const text =
      field.kind === 'select'
        ? (field.options.find((option) => option.selected)?.label ?? '')
        : field.password
          ? '•'.repeat([...field.value].length)
          : field.value;
    body = line(text, (height - size * 0.72) / 2);
  }
  return `/Tx BMC\nq 1 1 ${(width - 2).toFixed(2)} ${(height - 2).toFixed(2)} re W n\n${body}\nQ\nEMC`;
}

// A check box's square or a radio button's circle, centered in its widget, with its check or dot
// when it is on: vector paths, so they need no font at all.
function mark(kind: 'checkbox' | 'radio', width: number, height: number, on: boolean): string {
  const size = Math.min(width, height) - 1;
  const left = (width - size) / 2;
  const bottom = (height - size) / 2;
  const at = (x: number, y: number) =>
    `${(left + x * size).toFixed(2)} ${(bottom + y * size).toFixed(2)}`;
  const circle = (radius: number) => {
    const k = KAPPA * radius;
    const c = 0.5;
    return [
      `${at(c + radius, c)} m`,
      `${at(c + radius, c + k)} ${at(c + k, c + radius)} ${at(c, c + radius)} c`,
      `${at(c - k, c + radius)} ${at(c - radius, c + k)} ${at(c - radius, c)} c`,
      `${at(c - radius, c - k)} ${at(c - k, c - radius)} ${at(c, c - radius)} c`,
      `${at(c + k, c - radius)} ${at(c + radius, c - k)} ${at(c + radius, c)} c`,
    ].join(' ');
  };
  if (kind === 'checkbox') {
    const box = `0.46 0.46 0.46 RG 1 w ${at(0.05, 0.05)} ${(size * 0.9).toFixed(2)} ${(size * 0.9).toFixed(2)} re S`;
    const check = `0.10 0.45 0.91 RG ${(size * 0.14).toFixed(2)} w 1 J 1 j ${at(0.22, 0.52)} m ${at(0.42, 0.3)} l ${at(0.8, 0.74)} l S`;
    return `q ${box} ${on ? check : ''} Q`;
  }
  const ring = `0.46 0.46 0.46 RG 1 w ${circle(0.45)} S`;
  const dot = `0.10 0.45 0.91 rg ${circle(0.22)} f`;
  return `q ${ring} ${on ? dot : ''} Q`;
}

// `text` in pieces no wider than `width`, each the longest that fits, or one character when none
// does.
function pieces(text: string, size: number, width: number): string[] {
  if (text.length <= 1 || textWidth(text, size) <= width) return [text];
  // Longest first: the lengths short of the whole, down to one.
  const lengths = Array.from({ length: text.length - 1 }, (_, index) => text.length - 1 - index);
  const fit = lengths.find((length) => textWidth(text.slice(0, length), size) <= width) ?? 1;
  return [text.slice(0, fit), ...pieces(text.slice(fit), size, width)];
}
