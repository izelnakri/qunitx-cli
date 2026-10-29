// Reads what a test needs to know about a PDF — Chromium's or the raster writer's — without a PDF
// library: its pages' sizes, its title, whether its text is text (fonts) or pictures (JPEGs), and,
// where it has a plain cross-reference table, whether every offset in it lands on its object.

/**
 * What a PDF holds, as far as tests look.
 *
 * ```ts
 * const parsed: ParsedPdf = { pages: [[0, 0, 612, 792]], title: 'Home', fonts: true, jpegs: 0, xrefValid: null };
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
  /** For a classic `xref` table: whether each entry points at its object. Null without one. */
  xrefValid: boolean | null;
}

/**
 * Parses `bytes` as far as {@link ParsedPdf} goes.
 *
 * ```ts
 * import { parsePdf } from './pdf-parse.ts';
 *
 * parsePdf(new TextEncoder().encode('%PDF-1.4\n')).pages; // []
 * ```
 */
export function parsePdf(bytes: Uint8Array): ParsedPdf {
  const text = new TextDecoder('latin1').decode(bytes);
  const pages = [
    ...text.matchAll(
      /\/Type\s*\/Page(?![s\w])[^]*?\/MediaBox\s*\[([^\]]+)\]|\/MediaBox\s*\[([^\]]+)\][^]*?\/Type\s*\/Page(?![s\w])/g,
    ),
  ].map((match) => (match[1] ?? match[2]).trim().split(/\s+/).map(Number));
  const raw = /\/Title\s*(\((?:\\.|[^\\)])*\)|<[0-9a-fA-F]*>)/.exec(text)?.[1] ?? null;
  return {
    pages,
    title: raw === null ? null : decodeString(raw),
    fonts: /\/Font\b/.test(text),
    jpegs: (text.match(/\/DCTDecode/g) ?? []).length,
    xrefValid: checkXref(text),
  };
}

function decodeString(raw: string): string {
  if (raw.startsWith('(')) return raw.slice(1, -1).replace(/\\([\\()])/g, '$1');
  const hex = raw.slice(1, -1);
  const units: number[] = [];
  for (let at = 0; at < hex.length; at += 4) units.push(parseInt(hex.slice(at, at + 4), 16));
  return String.fromCharCode(...(units[0] === 0xfeff ? units.slice(1) : units));
}

function checkXref(text: string): boolean | null {
  const start = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
  if (!start || !text.startsWith('xref', Number(start[1]))) return null;
  const table = /xref\s+(\d+)\s+(\d+)\s+([^]*?)trailer/.exec(text.slice(Number(start[1])))!;
  const first = Number(table[1]);
  const entries = table[3].trim().split(/\s*\n\s*/);
  return entries.every((entry, index) => {
    const [offset, , kind] = entry.split(/\s+/);
    return kind === 'f' || text.startsWith(`${first + index} 0 obj`, Number(offset));
  });
}
