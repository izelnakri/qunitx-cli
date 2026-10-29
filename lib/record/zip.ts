import { crc32, deflateRawSync } from 'node:zlib';

/**
 * One file of a ZIP archive: its path inside it, its bytes, and whether to store them as they
 * are — right for what is compressed already, a JPEG or a PNG — rather than deflate them.
 *
 * ```ts
 * const entry: ZipEntry = { name: 'word/document.xml', bytes: new TextEncoder().encode('<w:document/>') };
 * ```
 */
export interface ZipEntry {
  /** Its path in the archive, `/`-separated. */
  name: string;
  /** What it holds. */
  bytes: Uint8Array;
  /** Stored as is, not deflated. */
  stored?: boolean;
}

// 1980-01-01 00:00, the earliest DOS date: the same input zips to the same bytes, every time.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/**
 * A ZIP archive of `entries`, in their order — the container of every Office Open XML file.
 * Entries are deflated unless `stored`; times are fixed, so the same entries make the same bytes.
 *
 * ```ts
 * import { zip } from './zip.ts';
 *
 * const archive = zip([{ name: 'a.txt', bytes: new TextEncoder().encode('hi') }]);
 * [archive[0], archive[1], archive[2], archive[3]]; // [0x50, 0x4b, 3, 4] — "PK", a local header
 * ```
 */
export function zip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const body = entry.stored ? entry.bytes : deflateRawSync(entry.bytes);
    const method = entry.stored ? 0 : 8;
    const crc = crc32(entry.bytes);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    // Bit 11: the name is UTF-8.
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, method, true);
    view.setUint16(10, DOS_TIME, true);
    view.setUint16(12, DOS_DATE, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, body.length, true);
    view.setUint32(22, entry.bytes.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const record = new DataView(central.buffer);
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, 0x0800, true);
    record.setUint16(10, method, true);
    record.setUint16(12, DOS_TIME, true);
    record.setUint16(14, DOS_DATE, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, body.length, true);
    record.setUint32(24, entry.bytes.length, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const directory = centrals.reduce((total, central) => total + central.length, 0);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, directory, true);
  view.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const archive = new Uint8Array(offset + directory + end.length);
  parts.reduce((at, part) => (archive.set(part, at), at + part.length), 0);
  return archive;
}
