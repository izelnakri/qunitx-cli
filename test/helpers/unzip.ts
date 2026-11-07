// Reads a ZIP archive the way an Office app does — from its central directory — checking each
// entry's CRC, so a test sees the parts of a .pptx, .docx or .xlsx exactly as written.
import { crc32, inflateRawSync } from 'node:zlib';

/**
 * One file read out of an archive.
 *
 * ```ts
 * const entry: UnzippedEntry = { name: 'a.txt', bytes: new Uint8Array(0), stored: true };
 * ```
 */
export interface UnzippedEntry {
  name: string;
  bytes: Uint8Array;
  /** Stored as is, not deflated. */
  stored: boolean;
}

/**
 * The entries of `archive`, in the central directory's order. Throws on a bad signature, an
 * unknown compression method or a CRC that does not match.
 *
 * ```ts
 * import { unzip } from './unzip.ts';
 * import { zip } from '../../lib/record/zip.ts';
 *
 * unzip(zip([{ name: 'a.txt', bytes: new TextEncoder().encode('hi') }]))[0].name; // 'a.txt'
 * ```
 */
export function unzip(archive: Uint8Array): UnzippedEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = archive.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50) throw new Error('no end of central directory');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries: UnzippedEntry[] = [];
  for (let index = 0; index < count; index++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error(`bad central header ${index}`);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(archive.subarray(at + 46, at + 46 + nameLength));
    if (view.getUint32(offset, true) !== 0x04034b50) throw new Error(`bad local header: ${name}`);
    const start =
      offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const body = archive.subarray(start, start + size);
    if (method !== 0 && method !== 8) throw new Error(`${name}: compression method ${method}`);
    const bytes = method === 0 ? body : new Uint8Array(inflateRawSync(body));
    if (crc32(bytes) !== crc) throw new Error(`${name}: CRC mismatch`);
    entries.push({ name, bytes, stored: method === 0 });
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

/**
 * Whether `text` is well-formed as far as tags go: every element closed, in order. Enough to
 * catch a writer's broken nesting without an XML parser.
 *
 * ```ts
 * import { balanced } from './unzip.ts';
 *
 * [balanced('<a><b/><c>x</c></a>'), balanced('<a><b></a></b>')]; // [true, false]
 * ```
 */
export function balanced(text: string): boolean {
  const open: string[] = [];
  for (const [, closing, name, selfClosing] of text
    .replace(/<\?[^]*?\?>/g, '')
    .matchAll(/<(\/?)([\w:.-]+)[^>]*?(\/?)>/g)) {
    if (selfClosing) continue;
    if (!closing) open.push(name);
    else if (open.pop() !== name) return false;
  }
  return open.length === 0;
}
