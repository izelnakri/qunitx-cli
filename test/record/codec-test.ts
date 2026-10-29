import { module, test } from 'qunitx';
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import * as GIF from '../../lib/record/gif.ts';
import * as PNG from '../../lib/record/png.ts';
import { quantize } from '../../lib/record/quantize.ts';
import { decodeGif } from '../helpers/gif-decode.ts';
import type { Image } from '../../lib/record/png.ts';

// An image filled by `color(x, y)` → 0xRRGGBB, fully opaque.
function image(width: number, height: number, color: (x: number, y: number) => number): Image {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgb = color(x, y);
      data.set([rgb >> 16, (rgb >> 8) & 0xff, rgb & 0xff, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

// A PNG written the way a browser writes one: RGB rows, each with its own filter.
async function filteredRgbPng(source: Image, filters: number[]): Promise<Uint8Array> {
  const stride = source.width * 3;
  const rgb = new Uint8Array(stride * source.height);
  for (let pixel = 0; pixel < source.width * source.height; pixel++) {
    rgb.set(source.data.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
  }
  const raw = new Uint8Array((stride + 1) * source.height);
  for (let y = 0; y < source.height; y++) {
    const filter = filters[y % filters.length];
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const at = (dx: number, dy: number) =>
        x + dx >= 0 && y + dy >= 0 ? rgb[(y + dy) * stride + x + dx] : 0;
      const [left, up, upLeft] = [at(-3, 0), at(0, -1), at(-3, -1)];
      const estimate = left + up - upLeft;
      const paeth =
        Math.abs(estimate - left) <= Math.abs(estimate - up) &&
        Math.abs(estimate - left) <= Math.abs(estimate - upLeft)
          ? left
          : Math.abs(estimate - up) <= Math.abs(estimate - upLeft)
            ? up
            : upLeft;
      const predicted = [0, left, up, (left + up) >> 1, paeth][filter];
      raw[y * (stride + 1) + 1 + x] = (rgb[y * stride + x] - predicted) & 0xff;
    }
  }
  // encode()'s signature and header, switched to color type 2 (RGB). decode() does not check
  // CRCs, so neither the edited header's nor the new chunks' need to be right.
  const header = (await PNG.encode({ ...source, data: new Uint8Array(source.data.length) })).slice(
    0,
    33,
  );
  header[25] = 2;
  return Buffer.concat([header, chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]);
}

module('Record | PNG', { concurrency: true }, () => {
  test('what encode writes, decode reads back pixel for pixel', async (assert) => {
    const source = image(7, 5, (x, y) => ((x * 36) << 16) | ((y * 50) << 8) | ((x + y) * 20));

    assert.deepEqual(PNG.decode(await PNG.encode(source)), source);
  });

  test('RGB rows under every filter type decode, widened to opaque RGBA', async (assert) => {
    const source = image(
      9,
      10,
      (x, y) => (((x * 29) % 256) << 16) | (((y * 41) % 256) << 8) | ((x * y * 7) % 256),
    );

    assert.deepEqual(PNG.decode(await filteredRgbPng(source, [0, 1, 2, 3, 4])), source);
  });

  test('anything that is not an 8-bit, non-interlaced RGB(A) PNG is refused by name', async (assert) => {
    const png = await PNG.encode(image(1, 1, () => 0));
    const palette = png.slice();
    palette[8 + 8 + 9] = 3; // color type 3: indexed

    assert.throws(() => PNG.decode(new Uint8Array(8)), /not a PNG/);
    assert.throws(() => PNG.decode(palette), /unsupported PNG: bit depth 8, color type 3/);
  });
});

module('Record | quantize', { concurrency: true }, () => {
  test('up to the limit, every color is kept exactly', (assert) => {
    const pixels = Array.from({ length: 1000 }, (_, n) => (n % 200) * 0x010101);
    const palette = quantize(pixels, 256);

    assert.equal(palette.colors.length, 200);
    assert.true(pixels.every((color) => palette.colors[palette.indexOf(color)] === color));
  });

  test('past the limit, median cut stays within the limit and close to every color', (assert) => {
    const pixels = Array.from(
      { length: 64 * 64 },
      (_, n) => (((n % 64) * 4) << 16) | (((n >> 6) * 4) << 8) | 128,
    );
    const palette = quantize(pixels, 64);
    const worst = Math.max(
      ...pixels.map((color) => {
        const picked = palette.colors[palette.indexOf(color)];
        return Math.max(
          Math.abs((picked >> 16) - (color >> 16)),
          Math.abs(((picked >> 8) & 0xff) - ((color >> 8) & 0xff)),
        );
      }),
    );

    assert.true(palette.colors.length <= 64);
    assert.true(worst <= 24, `every pixel lands near its own color (worst channel error ${worst})`);
  });
});

module('Record | GIF', { concurrency: true }, () => {
  test('frames decode back to exactly what went in, with their delays and a loop', (assert) => {
    const frames = [
      { image: image(20, 10, () => 0xff0000), delayMs: 500 },
      { image: image(20, 10, (x) => (x < 10 ? 0xff0000 : 0x0000ff)), delayMs: 250 },
      { image: image(20, 10, (x, y) => ((x + y) % 2 ? 0xffffff : 0x000000)), delayMs: 1000 },
    ];
    const gif = decodeGif(GIF.encode(frames));

    assert.equal(gif.width, 20);
    assert.true(gif.loops, 'loops forever');
    assert.deepEqual(
      gif.frames.map((frame) => frame.delayMs),
      [500, 250, 1000],
    );
    gif.frames.forEach((frame, index) => assert.deepEqual(frame.rgba, frames[index].image.data));
  });

  test('only what changed is written, and a frame that changed nothing extends the one before', (assert) => {
    const still = image(30, 30, () => 0x336699);
    const moved = image(30, 30, (x, y) =>
      x >= 10 && x < 15 && y >= 5 && y < 8 ? 0xffcc00 : 0x336699,
    );
    const encoder = new GIF.Encoder();
    encoder.add(still, 100);
    encoder.add(still, 100);
    encoder.add(moved, 300);
    const gif = decodeGif(encoder.finish());

    assert.equal(encoder.frames, 2);
    assert.deepEqual(
      gif.frames.map((frame) => frame.delayMs),
      [200, 300],
    );
    assert.deepEqual(gif.frames[1].rect, [10, 5, 5, 3], 'just the rectangle that moved');
    assert.deepEqual(gif.frames[1].rgba, moved.data);
  });

  test('delays round on the running total, so many short frames do not drift', (assert) => {
    const frames = Array.from({ length: 30 }, (_, n) => ({
      image: image(2, 2, () => n * 0x080808),
      delayMs: 33,
    }));
    const total = decodeGif(GIF.encode(frames)).frames.reduce(
      (sum, frame) => sum + frame.delayMs,
      0,
    );

    assert.equal(total, 990);
  });

  test('a frame too large for one LZW table, with more colors than a palette holds, still decodes', (assert) => {
    // Noise defeats the dictionary, so the 4096-code table fills and clears many times over.
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    const noisy = image(160, 120, () => random() & 0xffffff);
    const [frame] = decodeGif(GIF.encode([{ image: noisy, delayMs: 100 }])).frames;
    const worst = noisy.data.reduce(
      (worst, value, index) => Math.max(worst, Math.abs(frame.rgba[index] - value)),
      0,
    );

    assert.true(worst < 128, `quantized, not scrambled (worst channel error ${worst})`);
  });

  test('past 255 colors, a changed region shows each color one way: no ghosts of earlier frames', (assert) => {
    // A gradient has more colors than a palette holds, so every frame approximates them. Each next
    // frame slides every other column (and the last, so the change spans the frame), drawing colors
    // its unchanged columns still show. Left transparent, those would keep the previous frame's
    // approximation of a color beside this frame's: the scattered ghosts of earlier layouts.
    const tile = (x: number, y: number) =>
      (((x % 60) * 4) << 16) | ((y * 4) << 8) | (((x % 60) * 3 + y * 2) & 0xff);
    const frames = [0, 7, 15].map((shift) => ({
      image: image(120, 60, (x, y) => (x % 2 === 0 || x === 119 ? tile(x + shift, y) : tile(x, y))),
      delayMs: 100,
    }));
    const gif = decodeGif(GIF.encode(frames));

    gif.frames.forEach((frame, index) => {
      const source = frames[index].image.data;
      const shownAs = new Map<number, number>();
      let inconsistent = 0;
      for (let pixel = 0; pixel < source.length; pixel += 4) {
        const color = (source[pixel] << 16) | (source[pixel + 1] << 8) | source[pixel + 2];
        const shown =
          (frame.rgba[pixel] << 16) | (frame.rgba[pixel + 1] << 8) | frame.rgba[pixel + 2];
        if (!shownAs.has(color)) shownAs.set(color, shown);
        else if (shownAs.get(color) !== shown) inconsistent++;
      }
      assert.equal(inconsistent, 0, `frame ${index}: every color shown one way`);
    });
  });

  test('frames of different sizes are refused', (assert) => {
    const encoder = new GIF.Encoder();
    encoder.add(
      image(2, 2, () => 0),
      100,
    );

    assert.throws(
      () =>
        encoder.add(
          image(3, 2, () => 0),
          100,
        ),
      /must be 2×2, not 3×2/,
    );
    assert.throws(() => new GIF.Encoder().finish(), /at least one frame/);
  });
});

// A PNG chunk without its checksum: decode() does not check one.
function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  out.set(body, 8);
  return out;
}
