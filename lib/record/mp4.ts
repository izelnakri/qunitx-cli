import { Buffer } from 'node:buffer';
import { concatBytes } from '../utils/concat-bytes.ts';
import type { EncodedVideo } from './video.ts';

// Sample times are kept in milliseconds: frames are screenshots taken tens of ms apart, and a
// finer clock would only add digits.
const TIMESCALE = 1000;
// The identity transform every track header and movie header carries.
const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

/**
 * Writes encoded H.264 frames as an MP4 file: one video track, its index (`moov`) ahead of the
 * frames (`mdat`) so playback can start before the whole file has arrived, and each frame's own
 * duration in the time-to-sample table, so a page that sat still for two seconds is one frame
 * lasting two seconds. `description` is the encoder's `avcC` record, written as-is.
 *
 * ```ts
 * import * as MP4 from './mp4.ts';
 *
 * const mp4 = MP4.mux({
 *   codec: 'h264',
 *   width: 2,
 *   height: 2,
 *   description: Uint8Array.of(1, 0x42, 0, 0x1f, 0xff, 0xe0, 0),
 *   frames: [{ data: Uint8Array.of(0, 0, 0, 1, 0x65), timestampMs: 0, durationMs: 500, key: true }],
 * });
 * new TextDecoder().decode(mp4.subarray(4, 8)); // 'ftyp'
 * ```
 */
export function mux(video: EncodedVideo): Uint8Array {
  if (video.codec !== 'h264') throw new Error(`this MP4 writer holds H.264, not ${video.codec}`);
  const avcC = decoderConfiguration(video);
  const frames = video.frames;
  const durations = frames.map((frame) => Math.max(1, Math.round(frame.durationMs)));
  const duration = durations.reduce((total, ms) => total + ms, 0);

  const ftyp = box('ftyp', [
    fourcc('isom'),
    uint32BE(0x200),
    fourcc('isom'),
    fourcc('iso2'),
    fourcc('avc1'),
    fourcc('mp41'),
  ]);
  // The chunk offset depends on how big `moov` is, and `moov` holds the chunk offset: built once
  // with a placeholder to measure, then for real. A 32-bit offset is the same size either way.
  const build = (chunkOffset: number) =>
    box('moov', [
      fullBox('mvhd', 0, 0, [
        uint32BE(0),
        uint32BE(0),
        uint32BE(TIMESCALE),
        uint32BE(duration),
        uint32BE(0x00010000),
        uint16BE(0x0100),
        uint16BE(0),
        uint32BE(0),
        uint32BE(0),
        ...MATRIX.map(uint32BE),
        ...Array.from({ length: 6 }, () => uint32BE(0)),
        uint32BE(2), // next track ID
      ]),
      box('trak', [
        fullBox('tkhd', 0, 0x000003, [
          uint32BE(0),
          uint32BE(0),
          uint32BE(1),
          uint32BE(0),
          uint32BE(duration),
          uint32BE(0),
          uint32BE(0),
          uint16BE(0),
          uint16BE(0),
          uint16BE(0),
          uint16BE(0),
          ...MATRIX.map(uint32BE),
          uint32BE(video.width * 0x10000),
          uint32BE(video.height * 0x10000),
        ]),
        box('mdia', [
          fullBox('mdhd', 0, 0, [
            uint32BE(0),
            uint32BE(0),
            uint32BE(TIMESCALE),
            uint32BE(duration),
            uint16BE(0x55c4),
            uint16BE(0),
          ]),
          fullBox('hdlr', 0, 0, [
            uint32BE(0),
            fourcc('vide'),
            uint32BE(0),
            uint32BE(0),
            uint32BE(0),
            Buffer.from('VideoHandler\0'),
          ]),
          box('minf', [
            fullBox('vmhd', 0, 1, [uint16BE(0), uint16BE(0), uint16BE(0), uint16BE(0)]),
            box('dinf', [fullBox('dref', 0, 0, [uint32BE(1), fullBox('url ', 0, 1, [])])]),
            box('stbl', [
              fullBox('stsd', 0, 0, [uint32BE(1), sampleEntry(video, avcC)]),
              fullBox('stts', 0, 0, timeToSample(durations)),
              fullBox('stss', 0, 0, syncSamples(video)),
              fullBox('stsc', 0, 0, [
                uint32BE(1),
                uint32BE(1),
                uint32BE(frames.length),
                uint32BE(1),
              ]),
              fullBox('stsz', 0, 0, [
                uint32BE(0),
                uint32BE(frames.length),
                ...frames.map((frame) => uint32BE(frame.data.length)),
              ]),
              fullBox('stco', 0, 0, [uint32BE(1), uint32BE(chunkOffset)]),
            ]),
          ]),
        ]),
      ]),
    ]);
  const mdatHeader = 8;
  const moov = build(ftyp.length + build(0).length + mdatHeader);
  const payloadLength = frames.reduce((total, frame) => total + frame.data.length, 0);

  return concatBytes([
    ftyp,
    moov,
    uint32BE(mdatHeader + payloadLength),
    fourcc('mdat'),
    ...frames.map((frame) => frame.data),
  ]);
}

/**
 * The `avcC` record: built from the parameter sets in the first keyframe when it carries them, and
 * the encoder's own description otherwise. The bitstream wins because it is what decodes — Firefox
 * hands over an `avcC` whose SPS and PPS each start with their NAL header twice, which shifts every
 * field after it, while the same parameter sets in its keyframes are right.
 *
 * ```ts
 * import { decoderConfiguration } from './mp4.ts';
 *
 * const sps = [0x67, 0x42, 0xc0, 0x1f, 0xd9];
 * const pps = [0x68, 0xcb, 0x8c];
 * const key = Uint8Array.of(0, 0, 0, 5, ...sps, 0, 0, 0, 3, ...pps, 0, 0, 0, 2, 0x65, 0x88);
 * const frames = [{ data: key, timestampMs: 0, durationMs: 100, key: true }];
 * decoderConfiguration({ codec: 'h264', width: 2, height: 2, description: null, frames })[1]; // 0x42 — the profile
 * ```
 */
export function decoderConfiguration(video: EncodedVideo): Uint8Array {
  const key = video.frames.find((frame) => frame.key);
  const units = key ? nalUnits(key.data) : [];
  const sps = units.filter((unit) => (unit[0] & 0x1f) === 7);
  const pps = units.filter((unit) => (unit[0] & 0x1f) === 8);
  if (sps.length && pps.length) {
    const [, profile, compatibility, level] = sps[0];
    // Profiles 100 and up add the chroma and bit-depth fields; WebCodecs encodes 4:2:0 at 8 bits.
    const highProfile = [100, 110, 122, 144].includes(profile);
    return concatBytes([
      Uint8Array.of(1, profile, compatibility, level, 0xff, 0xe0 | sps.length),
      ...sps.flatMap((unit) => [uint16BE(unit.length), unit]),
      Uint8Array.of(pps.length),
      ...pps.flatMap((unit) => [uint16BE(unit.length), unit]),
      highProfile ? Uint8Array.of(0xfd, 0xf8, 0xf8, 0) : new Uint8Array(0),
    ]);
  } else if (video.description) {
    return video.description;
  }
  throw new Error('H.264 in MP4 needs its SPS and PPS, and the encoder gave neither');
}

// A frame's NAL units, each prefixed with its 4-byte length (WebCodecs' `avc` format).
function nalUnits(data: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let offset = 0; offset + 4 <= data.length;) {
    const length = view.getUint32(offset);
    units.push(data.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return units;
}

// The `avc1` visual sample entry, carrying the decoder configuration in its `avcC` box.
function sampleEntry(video: EncodedVideo, description: Uint8Array): Uint8Array {
  const compressorName = new Uint8Array(32);
  return box('avc1', [
    new Uint8Array(6),
    uint16BE(1), // reserved, data reference index
    uint16BE(0),
    uint16BE(0),
    uint32BE(0),
    uint32BE(0),
    uint32BE(0), // pre-defined and reserved
    uint16BE(video.width),
    uint16BE(video.height),
    uint32BE(0x00480000),
    uint32BE(0x00480000), // 72 dpi, both ways
    uint32BE(0),
    uint16BE(1),
    compressorName,
    uint16BE(0x0018),
    uint16BE(0xffff),
    box('avcC', [description]),
  ]);
}

// Runs of equal durations, as (count, delta) pairs.
function timeToSample(durations: number[]): Uint8Array[] {
  const runs: [number, number][] = [];
  for (const delta of durations) {
    const run = runs.at(-1);
    if (run && run[1] === delta) run[0]++;
    else runs.push([1, delta]);
  }
  return [
    uint32BE(runs.length),
    ...runs.flatMap(([count, delta]) => [uint32BE(count), uint32BE(delta)]),
  ];
}

// 1-based numbers of the frames a decoder can start from.
function syncSamples(video: EncodedVideo): Uint8Array[] {
  const keys = video.frames.flatMap((frame, index) => (frame.key ? [index + 1] : []));
  return [uint32BE(keys.length), ...keys.map(uint32BE)];
}

function box(type: string, body: Uint8Array[]): Uint8Array {
  const content = Buffer.concat(body);
  return Buffer.concat([uint32BE(8 + content.length), fourcc(type), content]);
}

function fullBox(type: string, version: number, flags: number, body: Uint8Array[]): Uint8Array {
  return box(type, [
    Uint8Array.of(version, flags >> 16, (flags >> 8) & 0xff, flags & 0xff),
    ...body,
  ]);
}

// A big-endian 32-bit number as its own four bytes: Buffer's writeUInt32BE.
function uint32BE(value: number): Uint8Array {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0);
  return out;
}

// A big-endian 16-bit number as its own two bytes: Buffer's writeUInt16BE.
function uint16BE(value: number): Uint8Array {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value & 0xffff);
  return out;
}

// A box type or brand: four ASCII characters.
function fourcc(value: string): Uint8Array {
  return Buffer.from(value, 'ascii');
}
