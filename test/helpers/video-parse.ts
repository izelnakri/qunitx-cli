// Readers for what lib/record/webm.ts and mp4.ts write, for asserting on structure: written from the
// Matroska and ISO BMFF specs rather than from the writers, so a shared mistake has to be made twice.

/**
 * What a WebM file holds, as far as tests look.
 *
 * ```ts
 * const webm: ParsedWebM = { docType: 'webm', codecId: 'V_VP9', width: 2, height: 2, durationMs: 1000, blocks: [], clusterStarts: [], cuePositions: [] };
 * webm.codecId; // 'V_VP9'
 * ```
 */
export interface ParsedWebM {
  docType: string;
  codecId: string;
  width: number;
  height: number;
  durationMs: number;
  blocks: { timeMs: number; key: boolean; size: number; durationMs: number | null }[];
  clusterStarts: number[];
  cuePositions: number[];
}

/**
 * Reads `bytes` as a WebM file, as far as {@link ParsedWebM} goes: its EBML header, its one video
 * track, each block with its time, and where its clusters start against where its cues point.
 *
 * ```ts
 * import { parseWebM } from './video-parse.ts';
 * import * as WebM from '../../lib/record/webm.ts';
 *
 * const frames = [{ data: Uint8Array.of(1, 2, 3), timestampMs: 0, durationMs: 1000, key: true }];
 * const webm = WebM.mux({ codec: 'vp9', width: 2, height: 2, description: null, frames });
 * parseWebM(webm).codecId; // 'V_VP9'
 * ```
 */
export function parseWebM(bytes: Uint8Array): ParsedWebM {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: ParsedWebM = {
    docType: '',
    codecId: '',
    width: 0,
    height: 0,
    durationMs: 0,
    blocks: [],
    clusterStarts: [],
    cuePositions: [],
  };
  let segmentBody = 0;
  let clusterTime = 0;
  const vint = (offset: number, keepMarker: boolean) => {
    const first = bytes[offset];
    // One byte per leading zero, plus the marker's: clz32 counts 24 zeros above a byte.
    const length = Math.clz32(first) - 23;
    let value = keepMarker ? first : first & (0xff >> length);
    for (let index = 1; index < length; index++) value = value * 256 + bytes[offset + index];
    return { value, length };
  };
  const uint = (start: number, end: number) => {
    let value = 0;
    for (let index = start; index < end; index++) value = value * 256 + bytes[index];
    return value;
  };
  const MASTERS = new Set([
    0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0, 0x1f43b675, 0xa0, 0x1c53bb6b, 0xbb,
    0xb7,
  ]);
  const walk = (start: number, end: number) => {
    for (let offset = start; offset < end;) {
      const id = vint(offset, true);
      const size = vint(offset + id.length, false);
      const body = offset + id.length + size.length;
      const bodyEnd = body + size.value;
      if (id.value === 0x18538067) segmentBody = body;
      if (id.value === 0x1f43b675) result.clusterStarts.push(offset - segmentBody);
      if (id.value === 0x4282)
        result.docType = new TextDecoder().decode(bytes.subarray(body, bodyEnd));
      else if (id.value === 0x86)
        result.codecId = new TextDecoder().decode(bytes.subarray(body, bodyEnd));
      else if (id.value === 0xb0) result.width = uint(body, bodyEnd);
      else if (id.value === 0xba) result.height = uint(body, bodyEnd);
      else if (id.value === 0x4489) result.durationMs = view.getFloat64(body);
      else if (id.value === 0xe7) clusterTime = uint(body, bodyEnd);
      else if (id.value === 0xf1) result.cuePositions.push(uint(body, bodyEnd));
      else if (id.value === 0xa3 || id.value === 0xa1) {
        result.blocks.push({
          timeMs: clusterTime + view.getInt16(body + 1),
          key: id.value === 0xa3 ? Boolean(bytes[body + 3] & 0x80) : false,
          size: size.value - 4,
          durationMs: null,
        });
      } else if (id.value === 0x9b)
        result.blocks[result.blocks.length - 1].durationMs = uint(body, bodyEnd);
      if (MASTERS.has(id.value)) walk(body, bodyEnd);
      offset = bodyEnd;
    }
  };
  walk(0, bytes.length);
  return result;
}

/**
 * What an MP4 file holds, as far as tests look.
 *
 * ```ts
 * const mp4: Pick<ParsedMp4, 'topLevel' | 'sampleEntry'> = { topLevel: ['ftyp', 'moov', 'mdat'], sampleEntry: 'avc1' };
 * mp4.topLevel[0]; // 'ftyp'
 * ```
 */
export interface ParsedMp4 {
  topLevel: string[];
  timescale: number;
  durationMs: number;
  width: number;
  height: number;
  sampleEntry: string;
  avcC: Uint8Array;
  sampleDurations: number[];
  syncSamples: number[];
  sampleSizes: number[];
  chunkOffset: number;
  mdatPayload: number;
}

/**
 * Reads `bytes` as an MP4 file, as far as {@link ParsedMp4} goes: its top-level boxes, the video
 * track's header and sample tables, and where its one chunk of frames starts.
 *
 * ```ts
 * import { parseMp4 } from './video-parse.ts';
 * import * as MP4 from '../../lib/record/mp4.ts';
 *
 * const description = Uint8Array.of(1, 0x42, 0, 0x1f, 0xff, 0xe0, 0);
 * const frames = [{ data: Uint8Array.of(0, 0, 0, 1, 0x65), timestampMs: 0, durationMs: 500, key: true }];
 * parseMp4(MP4.mux({ codec: 'h264', width: 2, height: 2, description, frames })).topLevel; // ['ftyp', 'moov', 'mdat']
 * ```
 */
export function parseMp4(bytes: Uint8Array): ParsedMp4 {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = (offset: number) => new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
  const boxes = new Map<string, number>();
  const topLevel: string[] = [];
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf']);
  const walk = (start: number, end: number, top: boolean) => {
    for (let offset = start; offset < end;) {
      const size = view.getUint32(offset);
      const name = type(offset);
      if (top) topLevel.push(name);
      boxes.set(name, offset);
      if (CONTAINERS.has(name)) walk(offset + 8, offset + size, false);
      if (name === 'stsd') walk(offset + 16, offset + size, false);
      if (name === 'avc1') walk(offset + 8 + 78, offset + size, false);
      offset += size;
    }
  };
  walk(0, bytes.length, true);
  const at = (name: string) => {
    const offset = boxes.get(name);
    if (offset === undefined) throw new Error(`no ${name} box`);
    return offset;
  };
  const mdhd = at('mdhd');
  const tkhd = at('tkhd');
  const avcC = at('avcC');
  const stts = at('stts');
  const stss = at('stss');
  const stsz = at('stsz');
  const sampleDurations: number[] = [];
  for (let entry = 0; entry < view.getUint32(stts + 12); entry++) {
    const count = view.getUint32(stts + 16 + entry * 8);
    const delta = view.getUint32(stts + 20 + entry * 8);
    for (let index = 0; index < count; index++) sampleDurations.push(delta);
  }
  const syncSamples = Array.from({ length: view.getUint32(stss + 12) }, (_, index) =>
    view.getUint32(stss + 16 + index * 4),
  );
  const sampleSizes = Array.from({ length: view.getUint32(stsz + 16) }, (_, index) =>
    view.getUint32(stsz + 20 + index * 4),
  );
  return {
    topLevel,
    timescale: view.getUint32(mdhd + 20),
    durationMs: view.getUint32(mdhd + 24),
    width: view.getUint32(tkhd + 84) / 0x10000,
    height: view.getUint32(tkhd + 88) / 0x10000,
    sampleEntry: type(boxes.get('avc1')!),
    avcC: bytes.subarray(avcC + 8, avcC + view.getUint32(avcC)),
    sampleDurations,
    syncSamples,
    sampleSizes,
    chunkOffset: view.getUint32(at('stco') + 16),
    mdatPayload: at('mdat') + 8,
  };
}
