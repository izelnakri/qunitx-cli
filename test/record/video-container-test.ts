import { module, test } from 'qunitx';
import * as MP4 from '../../lib/record/mp4.ts';
import * as WebM from '../../lib/record/webm.ts';
import { parseMp4, parseWebM } from '../helpers/video-parse.ts';
import type { EncodedVideo } from '../../lib/record/video.ts';

// Frames stand in for encoded data: the writers never look inside them, except the MP4 writer
// reading SPS/PPS out of a keyframe, which the H.264 frames below carry.
const SPS = [0x67, 0x42, 0xc0, 0x1f, 0xd9, 0x01];
const PPS = [0x68, 0xcb, 0x8c, 0xb2];
const nal = (...units: number[][]) =>
  Uint8Array.from(units.flatMap((unit) => [0, 0, 0, unit.length, ...unit]));

function video(codec: EncodedVideo['codec'], keys: boolean[], durations: number[]): EncodedVideo {
  let at = 0;
  return {
    codec,
    width: 320,
    height: 180,
    description: null,
    frames: keys.map((key, index) => {
      const data =
        codec === 'h264'
          ? key
            ? nal(SPS, PPS, [0x65, index])
            : nal([0x41, index, index])
          : Uint8Array.from({ length: 10 + index }, (_, n) => n);
      const frame = { data, timestampMs: at, durationMs: durations[index], key };
      at += durations[index];
      return frame;
    }),
  };
}

module('Record | WebM', { concurrency: true }, () => {
  test('one VP9 track, a cluster per keyframe, cues pointing at each, and a held last frame', (assert) => {
    const source = video('vp9', [true, false, false, true, false], [100, 100, 2000, 100, 1500]);
    const webm = parseWebM(WebM.mux(source));

    assert.equal(webm.docType, 'webm');
    assert.equal(webm.codecId, 'V_VP9');
    assert.deepEqual([webm.width, webm.height], [320, 180]);
    assert.equal(webm.durationMs, 3800);
    assert.deepEqual(
      webm.blocks.map((block) => block.timeMs),
      [0, 100, 200, 2200, 2300],
    );
    assert.deepEqual(webm.blocks.map((block) => block.key).slice(0, 4), [true, false, false, true]);
    assert.deepEqual(
      webm.blocks.map((block) => block.size),
      [10, 11, 12, 13, 14],
    );
    assert.equal(webm.blocks.at(-1)!.durationMs, 1500, 'the last frame says how long it stays');
    assert.deepEqual(webm.cuePositions, webm.clusterStarts, 'every cue lands on its cluster');
    assert.equal(webm.clusterStarts.length, 2);
  });

  test('a long stretch without a keyframe still fits block offsets in 16 bits', (assert) => {
    const keys = Array.from({ length: 5 }, (_, index) => index === 0);
    const webm = parseWebM(WebM.mux(video('vp8', keys, [20_000, 20_000, 20_000, 20_000, 100])));

    assert.equal(webm.codecId, 'V_VP8');
    assert.deepEqual(
      webm.blocks.map((block) => block.timeMs),
      [0, 20_000, 40_000, 60_000, 80_000],
    );
    assert.true(webm.clusterStarts.length >= 3, 'a new cluster before an offset could overflow');
  });

  test('H.264 is refused', (assert) => {
    assert.throws(() => WebM.mux(video('h264', [true], [100])), /WebM cannot hold h264/);
  });
});

module('Record | MP4', { concurrency: true }, () => {
  test('ftyp, then moov, then mdat; the sample tables describe the frames exactly', (assert) => {
    const source = video('h264', [true, false, false, true], [100, 100, 2000, 1000]);
    const bytes = MP4.mux(source);
    const mp4 = parseMp4(bytes);

    assert.deepEqual(
      mp4.topLevel,
      ['ftyp', 'moov', 'mdat'],
      'index first, so playback starts early',
    );
    assert.equal(mp4.sampleEntry, 'avc1');
    assert.deepEqual([mp4.width, mp4.height], [320, 180]);
    assert.equal(mp4.durationMs, 3200);
    assert.deepEqual(mp4.sampleDurations, [100, 100, 2000, 1000]);
    assert.deepEqual(mp4.syncSamples, [1, 4]);
    assert.deepEqual(
      mp4.sampleSizes,
      source.frames.map((frame) => frame.data.length),
    );
    assert.equal(mp4.chunkOffset, mp4.mdatPayload, 'the chunk offset points at the first frame');
    assert.deepEqual(
      [...bytes.subarray(mp4.chunkOffset, mp4.chunkOffset + source.frames[0].data.length)],
      [...source.frames[0].data],
    );
  });

  test('the avcC is built from the keyframe’s own SPS and PPS, not a broken description', (assert) => {
    const source = video('h264', [true], [100]);
    // Firefox's shape: every parameter set starts with its NAL header twice.
    source.description = Uint8Array.of(
      1,
      0x42,
      0xc0,
      0x1f,
      0x03,
      0x01,
      0,
      7,
      0x67,
      ...SPS,
      1,
      0,
      5,
      0x68,
      ...PPS,
    );
    const avcC = parseMp4(MP4.mux(source)).avcC;

    assert.deepEqual(
      [...avcC],
      [1, 0x42, 0xc0, 0x1f, 0xff, 0xe1, 0, SPS.length, ...SPS, 1, 0, PPS.length, ...PPS],
    );
  });

  test('a High-profile stream gets the chroma and bit-depth fields; a keyframe without parameter sets falls back to the description', (assert) => {
    const high = video('h264', [true], [100]);
    high.frames[0].data = nal([0x67, 100, 0, 0x33, 0xac], PPS, [0x65, 1]);
    const bare = video('h264', [true], [100]);
    bare.frames[0].data = nal([0x65, 1]);
    bare.description = Uint8Array.of(1, 0x42, 0, 0x1f, 0xff, 0xe0, 0);

    assert.deepEqual([...MP4.decoderConfiguration(high).slice(-4)], [0xfd, 0xf8, 0xf8, 0]);
    assert.deepEqual(MP4.decoderConfiguration(bare), bare.description);
    assert.throws(() => MP4.mux({ ...bare, description: null }), /needs its SPS and PPS/);
    assert.throws(() => MP4.mux(video('vp9', [true], [100])), /holds H\.264, not vp9/);
  });
});
