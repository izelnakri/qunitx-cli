import { Buffer } from 'node:buffer';
import { promisify } from 'node:util';
import { crc32, deflate, inflateSync } from 'node:zlib';
import { concatBytes } from '../utils/concat-bytes.ts';
import * as Outputs from './outputs.ts';
import type { RecordedFile } from './index.ts';
import type { Settings } from './options.ts';
import type { Page } from 'playwright-core';

// Compressed on libuv's thread pool, so the event loop is free meanwhile and several PNGs written at
// once compress side by side.
const deflateAsync = promisify(deflate);
// Every PNG opens with these eight bytes, whatever is in it.
const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
// Bytes per pixel for the colour types a browser screenshot can come back as: 2 is RGB, 6 is RGBA.
const CHANNELS: Record<number, number> = { 2: 3, 6: 4 };

/**
 * An image as rows of RGBA bytes, top to bottom: `data[(y * width + x) * 4]` is the red channel
 * of the pixel at `(x, y)`.
 *
 * ```ts
 * const image: Image = { width: 1, height: 1, data: Uint8Array.of(255, 0, 0, 255) };
 * image.data.length === image.width * image.height * 4; // true
 * ```
 */
export interface Image {
  /** In pixels. */
  width: number;
  /** In pixels. */
  height: number;
  /** `width * height * 4` bytes: red, green, blue, alpha per pixel. */
  data: Uint8Array;
}

/**
 * Decodes a PNG into RGBA pixels.
 *
 * Covers what Chromium, Firefox and WebKit hand back for a screenshot — 8-bit RGB or RGBA,
 * non-interlaced — and refuses anything else by name rather than decoding it wrong.
 *
 * ```ts
 * import * as PNG from './png.ts';
 *
 * const red = { width: 1, height: 1, data: Uint8Array.of(255, 0, 0, 255) };
 * PNG.decode(await PNG.encode(red)).data; // Uint8Array [255, 0, 0, 255]
 * ```
 */
export function decode(png: Uint8Array): Image {
  if (!SIGNATURE.every((byte, index) => png[index] === byte)) throw new Error('not a PNG');

  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  const compressed: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  let channels = 0;
  // Chunk by chunk: a length, a four-letter type, the body, and a checksum (12 bytes around it).
  for (
    let offset = SIGNATURE.length;
    offset < png.length;
    offset += 12 + bytes.readUInt32BE(offset)
  ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      const [depth, colorType, , , interlace] = body.subarray(8, 13);
      channels = CHANNELS[colorType] ?? 0;
      if (depth !== 8 || !channels || interlace !== 0) {
        throw new Error(
          `unsupported PNG: bit depth ${depth}, color type ${colorType}, interlace ${interlace}`,
        );
      }
    } else if (type === 'IDAT') {
      compressed.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }

  return {
    width,
    height,
    data: unfilter(inflateSync(Buffer.concat(compressed)), width, height, channels),
  };
}

/**
 * Encodes RGBA pixels as a PNG. Lossless, so a pixel read back is the pixel written. Compression,
 * nearly all of the work, runs off the main thread: write several with `Promise.all` and they
 * compress in parallel.
 *
 * ```ts
 * import * as PNG from './png.ts';
 *
 * const png = await PNG.encode({ width: 2, height: 1, data: new Uint8Array(8) });
 * png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47; // true — "PNG"
 * ```
 */
export async function encode(image: Image): Promise<Uint8Array> {
  const stride = image.width * 4;
  // Filter type 0 (none) on every row: screenshots compress well enough without the heuristics.
  const raw = new Uint8Array((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  // Width and height, then 8-bit RGBA, deflate, standard filtering, no interlace.
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header.set([8, 6, 0, 0, 0], 8);

  return concatBytes([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', await deflateAsync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// Undoes the per-row filter each scanline is prefixed with, widening RGB to RGBA on the way.
function unfilter(raw: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  // Each row's filter is chosen once, and its bytes undone in a loop of their own: a filter
  // dispatched per byte was two thirds of a decode. Uint8Array stores wrap mod 256, as PNG does.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    const above = row - stride;
    if (filter === 0 || (filter === 2 && y === 0)) {
      rows.set(raw.subarray(source, source + stride), row);
    } else if (filter === 1) {
      for (let x = 0; x < stride; x++) {
        rows[row + x] = raw[source + x] + (x >= channels ? rows[row + x - channels] : 0);
      }
    } else if (filter === 2) {
      for (let x = 0; x < stride; x++) rows[row + x] = raw[source + x] + rows[above + x];
    } else if (filter === 3) {
      for (let x = 0; x < stride; x++) {
        const left = x >= channels ? rows[row + x - channels] : 0;
        const up = y > 0 ? rows[above + x] : 0;
        rows[row + x] = raw[source + x] + ((left + up) >> 1);
      }
    } else if (filter === 4) {
      for (let x = 0; x < stride; x++) {
        const left = x >= channels ? rows[row + x - channels] : 0;
        const up = y > 0 ? rows[above + x] : 0;
        const upLeft = x >= channels && y > 0 ? rows[above + x - channels] : 0;
        rows[row + x] = raw[source + x] + paeth(left, up, upLeft);
      }
    } else throw new Error(`unsupported PNG: row filter ${filter}`);
  }
  if (channels === 4) return rows;

  const rgba = new Uint8Array(width * height * 4);
  for (let source = 0, target = 0; source < rows.length; source += 3, target += 4) {
    rgba[target] = rows[source];
    rgba[target + 1] = rows[source + 1];
    rgba[target + 2] = rows[source + 2];
    rgba[target + 3] = 255;
  }
  return rgba;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  return toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/**
 * A PNG's width and height in pixels, from its header, without decoding it.
 *
 * ```ts
 * import * as PNG from './png.ts';
 *
 * PNG.getDimensions(await PNG.encode({ width: 3, height: 2, data: new Uint8Array(24) })); // { width: 3, height: 2 }
 * ```
 */
export function getDimensions(png: Uint8Array): { width: number; height: number } {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * A PNG of `page` as it is: the viewport, or the whole page with `fullPage`, with each `mask`
 * selector covered, so comparing ignores what changes on its own. Under `compare` it is taken to
 * come out the same twice: animations finished and the text caret hidden. `scale: 'css'` shoots one pixel per CSS pixel, as a tour's
 * stills are below a scale of 2.
 *
 * ```ts
 * import * as PNG from './png.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live page.
 * async function shoot(page: Page) {
 *   return PNG.getDimensions(await PNG.screenshot(page, { fullPage: false, mask: ['#clock'], compare: true }));
 * }
 * ```
 */
export function screenshot(
  page: Page,
  {
    fullPage,
    mask,
    compare,
    scale = 'device',
  }: Pick<Settings, 'fullPage' | 'mask' | 'compare'> & { scale?: 'css' | 'device' },
): Promise<Uint8Array> {
  return page.screenshot({
    type: 'png',
    fullPage,
    scale,
    // A snapshot has to come out the same twice: a CSS transition caught mid-way or a blinking
    // caret is a difference nobody made.
    ...(compare ? { animations: 'disabled' as const, caret: 'hide' as const } : {}),
    ...(mask.length ? { mask: mask.map((selector) => page.locator(selector)) } : {}),
  });
}

/**
 * Writes a PNG of `page` as it is to `output`, taken as {@link screenshot} takes it and sized by
 * its own header.
 *
 * ```ts
 * import * as PNG from './png.ts';
 * import type { Output } from './outputs.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live page.
 * async function shoot(page: Page, output: Output) {
 *   return (await PNG.record(page, output, { fullPage: false, mask: [], compare: false })).width;
 * }
 * ```
 */
export async function record(
  page: Page,
  output: Outputs.Output,
  settings: Pick<Settings, 'fullPage' | 'mask' | 'compare'> & { scale?: 'css' | 'device' },
): Promise<RecordedFile> {
  const bytes = await screenshot(page, settings);
  return Outputs.write(output, bytes, { ...getDimensions(bytes), frames: 1 });
}
