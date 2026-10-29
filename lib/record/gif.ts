import { Buffer } from 'node:buffer';
import { exactPalette, quantize } from './quantize.ts';
import { concatBytes } from '../utils/concat-bytes.ts';
import * as Capture from './capture.ts';
import * as Outputs from './outputs.ts';
import * as PNG from './png.ts';
import type { Image } from './png.ts';
import type { RecordedFile } from './index.ts';

// Browsers stretch any delay under 2 centiseconds to 10, so 20ms is the shortest one that means
// what it says.
const MIN_DELAY_CS = 2;
const MAX_CODE = 4095;

/**
 * One image of an animation, and how long it stays on screen.
 *
 * ```ts
 * const frame: Frame = { image: { width: 1, height: 1, data: new Uint8Array(4) }, delayMs: 100 };
 * frame.delayMs; // 100
 * ```
 */
export interface Frame {
  /** What is shown. */
  image: Image;
  /** For how long. */
  delayMs: number;
}

// One frame as it will be written: the rectangle that changed, as palette indices.
interface EncodedFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  palette: number[];
  /** Palette index left transparent so the previous frame shows through, or -1 for none. */
  transparent: number;
  indices: Uint8Array;
  delayMs: number;
}

/**
 * Encodes frames as an animated GIF that loops forever. Shorthand for an {@link Encoder} fed
 * every frame in turn.
 *
 * ```ts
 * import * as GIF from './gif.ts';
 *
 * const solid = (red: number) => ({
 *   width: 2,
 *   height: 2,
 *   data: Uint8Array.from({ length: 16 }, (_, n) => (n % 4 === 0 ? red : n % 4 === 3 ? 255 : 0)),
 * });
 * const gif = GIF.encode([
 *   { image: solid(255), delayMs: 500 },
 *   { image: solid(0), delayMs: 500 },
 * ]);
 * new TextDecoder().decode(gif.subarray(0, 6)); // 'GIF89a'
 * ```
 */
export function encode(frames: Frame[]): Uint8Array {
  const encoder = new Encoder();
  for (const frame of frames) encoder.add(frame.image, frame.delayMs);
  return encoder.finish();
}

/**
 * Builds an animated GIF one frame at a time, holding only the frame before in memory — a long
 * recording is hundreds of full-size images, and they never need to exist all at once.
 *
 * Each frame gets its own palette — exact when it has 255 colors or fewer, median cut past that —
 * and only the rectangle that changed since the frame before is written, with its unchanged
 * pixels left transparent. A frame identical to the one before it is not written at all: its
 * time is added to the previous frame's, so a page sitting still costs nothing.
 *
 * ```ts
 * import * as GIF from './gif.ts';
 *
 * const black = { width: 1, height: 1, data: Uint8Array.of(0, 0, 0, 255) };
 * const encoder = new GIF.Encoder();
 * encoder.add(black, 1000);
 * encoder.add(black, 1000); // nothing changed: the first frame now lasts two seconds
 * encoder.frames; // 1
 * encoder.finish().at(-1); // 0x3b — the GIF trailer
 * ```
 */
export class Encoder {
  #writer = new ByteWriter();
  #previous: Image | null = null;
  #pendingFrame: EncodedFrame | null = null;
  #elapsedMs = 0;
  #frames = 0;

  /**
   * How many frames will be written: one per change, however many were added.
   *
   * ```ts
   * import * as GIF from './gif.ts';
   *
   * new GIF.Encoder().frames; // 0
   * ```
   */
  get frames(): number {
    return this.#frames;
  }

  /**
   * Adds a frame shown for `delayMs`. Every frame must be the size of the first.
   *
   * ```ts
   * import * as GIF from './gif.ts';
   *
   * const encoder = new GIF.Encoder();
   * encoder.add({ width: 1, height: 1, data: Uint8Array.of(255, 0, 0, 255) }, 100);
   * encoder.frames; // 1
   * ```
   */
  add(image: Image, delayMs: number): void {
    const previous = this.#previous;
    if (previous && (image.width !== previous.width || image.height !== previous.height)) {
      throw new Error(
        `every frame of a GIF must be ${previous.width}×${previous.height}, not ${image.width}×${image.height}`,
      );
    } else if (!previous) {
      this.#header(image.width, image.height);
    }
    const frame = encodeChange(previous?.data ?? null, image, delayMs);
    this.#previous = image;
    if (!frame) {
      this.#pendingFrame!.delayMs += delayMs;
    } else {
      this.#flush();
      this.#pendingFrame = frame;
      this.#frames++;
    }
  }

  /**
   * The finished GIF. Throws when no frame was added.
   *
   * ```ts
   * import * as GIF from './gif.ts';
   *
   * const encoder = new GIF.Encoder();
   * encoder.add({ width: 1, height: 1, data: new Uint8Array(4) }, 100);
   * new TextDecoder().decode(encoder.finish().subarray(0, 3)); // 'GIF'
   * ```
   */
  finish(): Uint8Array {
    if (!this.#previous) throw new Error('a GIF needs at least one frame');
    this.#flush();
    this.#writer.write([0x3b]);
    return this.#writer.finish();
  }

  #header(width: number, height: number): void {
    this.#writer.write(Buffer.from('GIF89a', 'ascii'));
    this.#writer.writeUInt16LE(width);
    this.#writer.writeUInt16LE(height);
    this.#writer.write([0x00, 0x00, 0x00]); // no global palette: every frame carries its own
    // NETSCAPE2.0 application extension: loop count 0, meaning forever.
    this.#writer.write([0x21, 0xff, 0x0b]);
    this.#writer.write(Buffer.from('NETSCAPE2.0', 'ascii'));
    this.#writer.write([0x03, 0x01, 0x00, 0x00, 0x00]);
  }

  // Written only once the next change arrives, because until then its delay can still grow.
  // Delays are in centiseconds, rounded on the running total so a hundred 33ms frames last 3.3s
  // rather than drifting by a rounding error per frame.
  #flush(): void {
    const frame = this.#pendingFrame;
    if (!frame) return;
    const start = Math.round(this.#elapsedMs / 10);
    this.#elapsedMs += frame.delayMs;
    writeFrame(
      this.#writer,
      frame,
      Math.max(MIN_DELAY_CS, Math.round(this.#elapsedMs / 10) - start),
    );
    this.#pendingFrame = null;
  }
}

/**
 * Writes one GIF of every clip in turn to `output`: each clip's shots kept to `fps`, each shown
 * until the next was taken, and its last for the clip's `lastFrameDurationMs`. Frames are decoded
 * one at a time as they are added, so a long recording never holds them all.
 *
 * ```ts
 * import * as GIF from './gif.ts';
 * import type { Clip } from './capture.ts';
 * import type { Output } from './outputs.ts';
 *
 * // Defined, not invoked: writes a file.
 * async function animate(output: Output, clips: Clip[]) {
 *   return (await GIF.record(output, clips, 10)).frames;
 * }
 * ```
 */
export function record(
  output: Outputs.Output,
  clips: Capture.Clip[],
  fps: number,
): Promise<RecordedFile> {
  const encoder = new Encoder();
  for (const { shots, lastFrameDurationMs } of clips) {
    const kept = Capture.limitFrameRate(shots, fps);
    kept.forEach((shot, index) => {
      const next = kept[index + 1];
      encoder.add(PNG.decode(shot.png), next ? next.atMs - shot.atMs : lastFrameDurationMs);
    });
  }
  const bytes = encoder.finish();
  // Every frame has the dimensions of the last, which a PNG states in its header.
  const last = clips.flatMap((clip) => clip.shots).at(-1);
  return Outputs.write(output, bytes, {
    ...(last ? PNG.getDimensions(last.png) : { width: 0, height: 0 }),
    frames: encoder.frames,
  });
}

// The part of `image` that differs from `previous`, encoded as a frame; null when nothing does.
function encodeChange(
  previous: Uint8Array | null,
  image: Image,
  delayMs: number,
): EncodedFrame | null {
  const bounds = changedBounds(previous, image);
  if (!bounds) return null;
  const { left, top, width, height } = bounds;
  // The rectangle's pixels, row by row: each one's color, and whether the previous frame has it.
  const colors = new Int32Array(width * height);
  const kept = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = ((top + y) * image.width + left + x) * 4;
      colors[y * width + x] = rgbAt(image.data, offset);
      kept[y * width + x] = Number(previous !== null && samePixel(previous, image.data, offset));
    }
  }
  // Sparse, the usual case: unchanged pixels left transparent, so one palette slot is held back.
  // But more changed colors than a palette holds are each approximated, a little differently in
  // every frame, and transparent pixels would keep an earlier frame's approximation of a color this
  // frame draws another way (faint ghosts of earlier layouts): such a rectangle is drawn whole.
  const changed = previous ? changedColors(colors, kept) : colors;
  const sparsePalette = changed.length < colors.length ? exactPalette(changed, 255) : null;
  const sparse = sparsePalette !== null;
  const palette = sparsePalette ?? quantize(colors, 256);
  const transparent = sparse ? palette.colors.length : -1;
  const indices = new Uint8Array(colors.length);
  for (let index = 0; index < colors.length; index++) {
    indices[index] = sparse && kept[index] ? transparent : palette.indexOf(colors[index]);
  }

  return {
    left,
    top,
    width,
    height,
    palette: sparse ? [...palette.colors, 0] : palette.colors,
    transparent,
    indices,
    delayMs,
  };
}

// The smallest rectangle around every pixel of `image` that differs from `previous` (the whole
// image when there is none), or null when none does.
function changedBounds(
  previous: Uint8Array | null,
  { width, height, data }: Image,
): { left: number; top: number; width: number; height: number } | null {
  if (!previous) return { left: 0, top: 0, width, height };
  let [left, top, right, bottom] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!samePixel(previous, data, (y * width + x) * 4)) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = y;
      }
    }
  }
  return right === -1 ? null : { left, top, width: right - left + 1, height: bottom - top + 1 };
}

// A pixel's color as 0xRRGGBB.
function rgbAt(data: Uint8Array, offset: number): number {
  return (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
}

function writeFrame(writer: ByteWriter, frame: EncodedFrame, delayCs: number): void {
  // A palette's size is a power of two, at least 2; LZW codes start a bit wider, at least 3 bits.
  const bits = Math.max(1, Math.ceil(Math.log2(frame.palette.length)));
  const minCodeSize = Math.max(2, bits);
  const hasTransparency = frame.transparent !== -1;

  // Graphic control extension: disposal 1 (leave the frame in place for the next to draw over),
  // the delay, and the transparent index when there is one.
  writer.write([0x21, 0xf9, 0x04, (1 << 2) | Number(hasTransparency)]);
  writer.writeUInt16LE(delayCs);
  writer.write([hasTransparency ? frame.transparent : 0, 0x00]);
  // Image descriptor: where the frame goes, then a local palette of 2^bits colours.
  writer.write([0x2c]);
  [frame.left, frame.top, frame.width, frame.height].forEach((value) =>
    writer.writeUInt16LE(value),
  );
  writer.write([0x80 | (bits - 1)]);
  writer.write(
    Array.from({ length: 1 << bits }, (_, index) => frame.palette[index] ?? 0).flatMap((color) => [
      color >> 16,
      (color >> 8) & 0xff,
      color & 0xff,
    ]),
  );
  // Image data: the code size, the codes in sub-blocks of up to 255 bytes, and an empty one to end.
  writer.write([minCodeSize]);
  const compressed = lzw(frame.indices, minCodeSize);
  for (let offset = 0; offset < compressed.length; offset += 255) {
    const block = compressed.subarray(offset, offset + 255);
    writer.write([block.length]);
    writer.write(block);
  }
  writer.write([0x00]);
}

// GIF's variant of LZW: variable-width codes from minCodeSize + 1 up to 12 bits, packed LSB-first,
// with a clear code whenever the 4096-entry table fills.
function lzw(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const writer = new BitWriter();
  // The code for each string seen, by `prefix code << 8 | next index`.
  const codes = new Map<number, number>();
  let next = end + 1;
  let width = minCodeSize + 1;

  writer.write(clear, width);
  let prefix = indices[0];
  for (let index = 1; index < indices.length; index++) {
    const key = (prefix << 8) | indices[index];
    const code = codes.get(key);
    if (code !== undefined) {
      // A string already in the table: it goes on.
      prefix = code;
    } else {
      writer.write(prefix, width);
      if (next > MAX_CODE) {
        writer.write(clear, width);
        codes.clear();
        next = end + 1;
        width = minCodeSize + 1;
      } else {
        codes.set(key, next);
        if (next === 1 << width && width < 12) width++;
        next++;
      }
      prefix = indices[index];
    }
  }
  writer.write(prefix, width);
  writer.write(end, width);
  return writer.finish();
}

// The GIF's bytes in order. Small writes gather as numbers, then pack into one segment when a
// large array arrives (kept whole rather than copied byte by byte) or at the end.
class ByteWriter {
  #pendingBytes: number[] = [];
  #segments: Uint8Array[] = [];

  // Appends bytes, as a Node stream's `write(chunk)` does. A large array is kept as it is:
  // `finish()` copies every segment once.
  write(bytes: ArrayLike<number>): void {
    if (bytes instanceof Uint8Array && bytes.length > 64) {
      this.#flush();
      this.#segments.push(bytes);
    } else {
      for (let index = 0; index < bytes.length; index++) this.#pendingBytes.push(bytes[index]);
    }
  }

  // Appends a 16-bit number, low byte first: Buffer's `writeUInt16LE`, at the end.
  writeUInt16LE(value: number): void {
    this.#pendingBytes.push(value & 0xff, value >> 8);
  }

  finish(): Uint8Array {
    this.#flush();
    return concatBytes(this.#segments);
  }

  #flush(): void {
    if (this.#pendingBytes.length) this.#segments.push(Buffer.from(this.#pendingBytes));
    this.#pendingBytes = [];
  }
}

class BitWriter {
  #bytes: number[] = [];
  #buffer = 0;
  #count = 0;

  write(code: number, width: number): void {
    this.#buffer |= code << this.#count;
    this.#count += width;
    for (; this.#count >= 8; this.#count -= 8) {
      this.#bytes.push(this.#buffer & 0xff);
      this.#buffer >>>= 8;
    }
  }

  finish(): Uint8Array {
    if (this.#count > 0) this.#bytes.push(this.#buffer & 0xff);
    return Uint8Array.from(this.#bytes);
  }
}

// The colors of the pixels the previous frame does not have, in order: filled in place and cut to
// length, which costs a full-frame change a seventh of a growing array's pushes.
function changedColors(colors: Int32Array, kept: Uint8Array): Int32Array {
  const changed = new Int32Array(colors.length);
  let count = 0;
  for (let index = 0; index < colors.length; index++) {
    if (!kept[index]) changed[count++] = colors[index];
  }
  return changed.subarray(0, count);
}

function samePixel(previous: Uint8Array, current: Uint8Array, offset: number): boolean {
  return (
    previous[offset] === current[offset] &&
    previous[offset + 1] === current[offset + 1] &&
    previous[offset + 2] === current[offset + 2]
  );
}
