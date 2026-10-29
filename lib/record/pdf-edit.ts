// Just enough of a PDF reader and writer to change a PDF Chromium or `PDF.encode` made: objects
// read through a classic cross-reference table, and changes appended as an incremental update,
// so nothing already there is rewritten or re-encoded.

/**
 * A PDF value: a number, a boolean, null, a name (`{ name }`, as written, without its `/`), a
 * reference to an object (`{ ref }`), a string (`{ string }`, as written, delimiters and all), an
 * array, or a dictionary (a `Map` by key, without the `/`).
 *
 * ```ts
 * const value: PdfValue = new Map<string, PdfValue>([['Type', { name: 'Page' }], ['Parent', { ref: 2 }]]);
 * ```
 */
export type PdfValue =
  | number
  | boolean
  | null
  | { name: string }
  | { ref: number }
  | { string: string }
  | PdfValue[]
  | Map<string, PdfValue>;

/**
 * A PDF opened to be read and appended to: its text (a character per byte), where each object
 * starts, the next free object number, and its trailer.
 *
 * ```ts
 * import { openPdf } from './pdf-edit.ts';
 * import * as PDF from './pdf.ts';
 *
 * const file: PdfFile = openPdf(PDF.encode([], { title: 'Empty' }));
 * file.size; // 4
 * ```
 */
export interface PdfFile {
  /** The PDF as it is. */
  bytes: Uint8Array;
  /** The same, a character per byte. */
  text: string;
  /** Where each object in use starts, by object number. */
  offsets: Map<number, number>;
  /** One more than the highest object number. */
  size: number;
  /** Its latest trailer. */
  trailer: Map<string, PdfValue>;
  /** Where its last cross-reference table starts. */
  xref: number;
}

/**
 * Opens a PDF whose cross-reference tables are plain tables, as Chromium's and `PDF.encode`'s are,
 * following earlier updates back. One with a cross-reference stream is refused.
 *
 * ```ts
 * import { openPdf } from './pdf-edit.ts';
 * import * as PDF from './pdf.ts';
 *
 * openPdf(PDF.encode([], { title: 'Empty' })).offsets.has(1); // true
 * ```
 */
export function openPdf(bytes: Uint8Array): PdfFile {
  const text = new TextDecoder('latin1').decode(bytes);
  const last = [...text.matchAll(/startxref\s+(\d+)/g)].at(-1);
  if (!last) throw new Error('not a PDF: no startxref');
  const offsets = new Map<number, number>();
  let trailer: Map<string, PdfValue> | null = null;
  let size = 0;
  for (let at: number | null = Number(last[1]); at !== null;) {
    const reader = new Reader(text, at);
    if (reader.word() !== 'xref') throw new Error('a cross-reference stream is not supported');
    for (;;) {
      const word = reader.word();
      if (word === 'trailer') break;
      const first = Number(word);
      const count = Number(reader.word());
      for (let index = 0; index < count; index++) {
        const offset = Number(reader.word());
        reader.word();
        const kind = reader.word();
        if (kind === 'n' && !offsets.has(first + index)) offsets.set(first + index, offset);
      }
    }
    const section = reader.value() as Map<string, PdfValue>;
    trailer ??= section;
    size = Math.max(size, Number(section.get('Size') ?? 0));
    const previous = section.get('Prev');
    at = typeof previous === 'number' ? previous : null;
  }
  return { bytes, text, offsets, size, trailer: trailer!, xref: Number(last[1]) };
}

/**
 * Object `id` of `file`: its value, or a stream's dictionary.
 *
 * ```ts
 * import { openPdf, readObject } from './pdf-edit.ts';
 * import * as PDF from './pdf.ts';
 *
 * const file = openPdf(PDF.encode([], { title: 'Empty' }));
 * (readObject(file, 1) as Map<string, unknown>).get('Type'); // { name: 'Catalog' }
 * ```
 */
export function readObject(file: PdfFile, id: number): PdfValue {
  const offset = file.offsets.get(id);
  if (offset === undefined) return null;
  const reader = new Reader(file.text, offset);
  reader.word();
  reader.word();
  reader.word();
  return reader.value();
}

/**
 * `value`, or the object it refers to.
 *
 * ```ts
 * import { openPdf, resolve } from './pdf-edit.ts';
 * import * as PDF from './pdf.ts';
 *
 * const file = openPdf(PDF.encode([], { title: 'Empty' }));
 * resolve(file, 7); // 7
 * ```
 */
export function resolve(file: PdfFile, value: PdfValue | undefined): PdfValue {
  return isRef(value) ? readObject(file, value.ref) : (value ?? null);
}

/**
 * Parses one PDF value from `source`.
 *
 * ```ts
 * import { parseValue } from './pdf-edit.ts';
 *
 * parseValue('[1 0 R /XYZ 6 (a\\)b) <</K true>>]');
 * // [{ ref: 1 }, { name: 'XYZ' }, 6, { string: '(a\\)b)' }, Map { 'K' => true }]
 * ```
 */
export function parseValue(source: string): PdfValue {
  return new Reader(source, 0).value();
}

/**
 * A PDF value written out, as {@link parseValue} reads it back.
 *
 * ```ts
 * import { parseValue, writeValue } from './pdf-edit.ts';
 *
 * writeValue(parseValue('<</Rect [0 0 10 20] /P 3 0 R>>')); // '<< /Rect [0 0 10 20] /P 3 0 R >>'
 * ```
 */
export function writeValue(value: PdfValue): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return String(+value.toFixed(4));
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(writeValue).join(' ')}]`;
  if (value instanceof Map) {
    return `<< ${[...value].map(([key, entry]) => `/${key} ${writeValue(entry)}`).join(' ')} >>`;
  }
  if ('name' in value) return `/${value.name}`;
  if ('ref' in value) return `${value.ref} 0 R`;
  return value.string;
}

/**
 * Whether `value` refers to an object.
 *
 * ```ts
 * import { isRef } from './pdf-edit.ts';
 *
 * isRef({ ref: 3 }); // true
 * isRef(3); // false
 * ```
 */
export function isRef(value: PdfValue | undefined): value is { ref: number } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'ref' in value;
}

/**
 * `file` with `objects` added, or put in place of the objects of the same number, as an
 * incremental update: appended, with a cross-reference table of its own pointing back to the
 * last. `trailer` entries are added to the trailer (its `Root` and `Info` stay unless replaced).
 *
 * ```ts
 * import { appendObjects, openPdf } from './pdf-edit.ts';
 * import * as PDF from './pdf.ts';
 *
 * const file = openPdf(PDF.encode([], { title: 'Empty' }));
 * const updated = appendObjects(file, [{ id: 4, body: '(added)' }]);
 * openPdf(updated).size; // 5
 * ```
 */
export function appendObjects(
  file: PdfFile,
  objects: { id: number; body: string }[],
  trailer: Map<string, PdfValue> = new Map(),
): Uint8Array {
  let text = file.text.endsWith('\n') ? '' : '\n';
  const offsets = new Map<number, number>();
  for (const { id, body } of objects) {
    offsets.set(id, file.bytes.length + text.length);
    text += `${id} 0 obj\n${body}\nendobj\n`;
  }
  const ids = [...offsets.keys()].sort((a, b) => a - b);
  const xref = file.bytes.length + text.length;
  text += 'xref\n';
  // A subsection per run of consecutive object numbers.
  const runs = ids.reduce<number[][]>((groups, id) => {
    const last = groups.at(-1);
    if (last && id === (last.at(-1) as number) + 1) last.push(id);
    else groups.push([id]);
    return groups;
  }, []);
  for (const run of runs) {
    text += `${run[0]} ${run.length}\n`;
    for (const id of run) text += `${String(offsets.get(id)).padStart(10, '0')} 00000 n \n`;
  }
  const size = Math.max(file.size, (ids.at(-1) ?? 0) + 1);
  const entries = new Map(file.trailer);
  for (const key of ['Prev', 'XRefStm', 'Encrypt']) entries.delete(key);
  for (const [key, value] of trailer) entries.set(key, value);
  entries.set('Size', size);
  entries.set('Prev', file.xref);
  text += `trailer\n${writeValue(entries)}\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(file.bytes.length + text.length);
  bytes.set(file.bytes);
  for (let at = 0; at < text.length; at++) bytes[file.bytes.length + at] = text.charCodeAt(at);
  return bytes;
}

// Sticky, so each matches at the reader's position: a word runs to the next delimiter;
// space is white space and `%` comments, to the end of their line.
const WORD = /[^\s()<>[\]{}/%]*/y;
const SPACE = /(?:\s|%[^\r\n]*)*/y;

// Reads PDF tokens and values from a character-per-byte string, from `at` on.
class Reader {
  readonly #source: string;
  #at: number;

  constructor(source: string, at: number) {
    this.#source = source;
    this.#at = at;
  }

  word(): string {
    this.#space();
    WORD.lastIndex = this.#at;
    const word = (WORD.exec(this.#source) as RegExpExecArray)[0];
    this.#at += word.length;
    return word;
  }

  value(): PdfValue {
    this.#space();
    const source = this.#source;
    const character = source[this.#at];
    if (source.startsWith('<<', this.#at)) {
      this.#at += 2;
      const entries = new Map<string, PdfValue>();
      for (this.#space(); !source.startsWith('>>', this.#at); this.#space()) {
        if (this.#at >= source.length) throw new Error('unterminated dictionary');
        this.#at++;
        const key = this.word();
        entries.set(key, this.value());
      }
      this.#at += 2;
      return entries;
    }
    if (character === '[') {
      this.#at++;
      const items: PdfValue[] = [];
      for (this.#space(); source[this.#at] !== ']'; this.#space()) {
        if (this.#at >= source.length) throw new Error('unterminated array');
        items.push(this.value());
      }
      this.#at++;
      return items;
    }
    if (character === '/') {
      this.#at++;
      return { name: this.word() };
    }
    if (character === '(') {
      const start = this.#at;
      let depth = 0;
      for (; this.#at < source.length; this.#at++) {
        if (source[this.#at] === '\\') this.#at++;
        else if (source[this.#at] === '(') depth++;
        else if (source[this.#at] === ')' && --depth === 0) break;
      }
      this.#at++;
      return { string: source.slice(start, this.#at) };
    }
    if (character === '<') {
      const end = source.indexOf('>', this.#at);
      const string = source.slice(this.#at, end + 1);
      this.#at = end + 1;
      return { string };
    }
    const word = this.word();
    if (word === 'true' || word === 'false') return word === 'true';
    if (word === 'null') return null;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word))
      throw new Error(`unexpected ${JSON.stringify(word)}`);
    // `12 0 R`: a reference, when two more words follow that make one.
    const mark = this.#at;
    const generation = this.word();
    if (/^\d+$/.test(word) && /^\d+$/.test(generation) && this.word() === 'R') {
      return { ref: Number(word) };
    }
    this.#at = mark;
    return Number(word);
  }

  #space(): void {
    SPACE.lastIndex = this.#at;
    this.#at += (SPACE.exec(this.#source) as RegExpExecArray)[0].length;
  }
}
