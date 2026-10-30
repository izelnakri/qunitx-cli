import { Buffer } from 'node:buffer';
import { concatBytes } from '../utils/concat-bytes.ts';
import type { EncodedVideo } from './video.ts';

// The byte counts an EBML size can take.
const SIZE_LENGTHS = [1, 2, 3, 4, 5, 6, 7, 8];

// Matroska element IDs, by the name the spec gives them. Only what one video track needs.
const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  CodecID: 0x86,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
} as const;

// What Matroska calls each WebCodecs codec this writes.
const CODEC_IDS: Record<string, string> = { vp8: 'V_VP8', vp9: 'V_VP9', av1: 'V_AV1' };
// A block's timecode is a signed 16-bit offset from its cluster's, in ms.
const MAX_CLUSTER_SPAN_MS = 30_000;

// An element as the pieces it is written from, joined once at the end: nesting copies no frame.
type Parts = Uint8Array[];

/**
 * Writes encoded VP8, VP9 or AV1 frames as a WebM file: one video track, a cluster opening at each
 * keyframe, and cues pointing at them so players can seek. The last frame is a `BlockGroup` with a
 * duration, so it stays on screen for its hold rather than flashing past.
 *
 * ```ts
 * import * as WebM from './webm.ts';
 *
 * const webm = WebM.mux({
 *   codec: 'vp9',
 *   width: 2,
 *   height: 2,
 *   description: null,
 *   frames: [{ data: Uint8Array.of(1, 2, 3), timestampMs: 0, durationMs: 1000, key: true }],
 * });
 * webm[0] === 0x1a && webm[1] === 0x45; // true — an EBML header
 * ```
 */
export function mux(video: EncodedVideo): Uint8Array {
  const codecId = CODEC_IDS[video.codec];
  if (!codecId) throw new Error(`WebM cannot hold ${video.codec}`);
  const last = video.frames.at(-1);
  const durationMs = last ? last.timestampMs + last.durationMs : 0;

  const header = element(ID.EBML, [
    uint(ID.EBMLVersion, 1),
    uint(ID.EBMLReadVersion, 1),
    uint(ID.EBMLMaxIDLength, 4),
    uint(ID.EBMLMaxSizeLength, 8),
    text(ID.DocType, 'webm'),
    uint(ID.DocTypeVersion, 4),
    uint(ID.DocTypeReadVersion, 2),
  ]);
  const info = element(ID.Info, [
    uint(ID.TimecodeScale, 1_000_000), // timecodes in milliseconds
    text(ID.MuxingApp, 'qunitx'),
    text(ID.WritingApp, 'qunitx record'),
    float(ID.Duration, durationMs),
  ]);
  const tracks = element(ID.Tracks, [
    element(ID.TrackEntry, [
      uint(ID.TrackNumber, 1),
      uint(ID.TrackUID, 1),
      uint(ID.TrackType, 1), // video
      uint(ID.FlagLacing, 0),
      text(ID.CodecID, codecId),
      element(ID.Video, [uint(ID.PixelWidth, video.width), uint(ID.PixelHeight, video.height)]),
    ]),
  ]);

  // A new cluster at each keyframe, and before a block's offset from its cluster would overflow.
  const groups = video.frames.reduce<{ startMs: number; blocks: Parts[] }[]>(
    (groups, frame, index) => {
      const timeMs = Math.round(frame.timestampMs);
      const open = groups.at(-1);
      if (!open || frame.key || timeMs - open.startMs > MAX_CLUSTER_SPAN_MS) {
        groups.push({ startMs: timeMs, blocks: [] });
      }
      const cluster = groups.at(-1)!;
      const block = blockParts(timeMs - cluster.startMs, frame.key, frame.data);
      cluster.blocks.push(
        index === video.frames.length - 1
          ? element(ID.BlockGroup, [
              bytes(ID.Block, block),
              uint(ID.BlockDuration, Math.max(1, Math.round(frame.durationMs))),
            ])
          : bytes(ID.SimpleBlock, block),
      );
      return groups;
    },
    [],
  );
  const clusters = groups.map(({ startMs, blocks }) =>
    element(ID.Cluster, [uint(ID.Timecode, startMs), ...blocks]),
  );
  // Where each cluster starts in the segment's body: what the cues point at.
  const positions = clusters.reduce<number[]>(
    (starts, cluster) => {
      starts.push(starts.at(-1)! + lengthOf(cluster));
      return starts;
    },
    [lengthOf(info) + lengthOf(tracks)],
  );
  const cues = element(
    ID.Cues,
    groups.map(({ startMs }, index) =>
      element(ID.CuePoint, [
        uint(ID.CueTime, startMs),
        element(ID.CueTrackPositions, [
          uint(ID.CueTrack, 1),
          uint(ID.CueClusterPosition, positions[index]),
        ]),
      ]),
    ),
  );

  return concatBytes([...header, ...element(ID.Segment, [info, tracks, ...clusters, cues])]);
}

// A (Simple)Block's body: track number 1, the timecode relative to its cluster, flags, the frame.
function blockParts(relativeMs: number, key: boolean, data: Uint8Array): Parts {
  const head = Buffer.alloc(4);
  head[0] = 0x81; // track 1, as a one-byte vint
  head.writeInt16BE(relativeMs, 1);
  head[3] = key ? 0x80 : 0x00;
  return [head, data];
}

function element(id: number, children: Parts[]): Parts {
  return bytes(id, children.flat());
}

function bytes(id: number, body: Uint8Array | Parts): Parts {
  const parts = body instanceof Uint8Array ? [body] : body;
  return [shortestBigEndian(id), size(lengthOf(parts)), ...parts];
}

function lengthOf(parts: Parts): number {
  return parts.reduce((total, part) => total + part.length, 0);
}

function uint(id: number, value: number): Parts {
  return bytes(id, shortestBigEndian(value));
}

function float(id: number, value: number): Parts {
  const body = Buffer.alloc(8);
  body.writeDoubleBE(value);
  return bytes(id, body);
}

function text(id: number, value: string): Parts {
  return bytes(id, Buffer.from(value));
}

// The fewest big-endian bytes that hold `value`, at least one: an element ID as written (its
// leading bits already say how long it is), or an unsigned integer element's body.
function shortestBigEndian(value: number): Uint8Array {
  const length = Math.max(1, Math.ceil(value.toString(16).length / 2));
  const out = Buffer.alloc(length);
  out.writeUIntBE(value, 0, length);
  return out;
}

// A size as an EBML variable-length integer: the first byte's leading zeros say how many follow.
// Lengths whose every value bit would be 1 are reserved for "unknown", so they take one more byte.
function size(value: number): Uint8Array {
  const length = SIZE_LENGTHS.find((bytes) => value < 2 ** (7 * bytes) - 1) ?? 8;
  const out = new Uint8Array(length);
  let rest = value;
  for (let index = length - 1; index >= 0; index--) {
    out[index] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}
