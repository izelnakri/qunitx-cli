/**
 * Color quantization: redrawing an image with a small palette of colors, each pixel becoming the
 * nearest one. A GIF frame holds at most 256 colors (each pixel stores a palette index), while a
 * screenshot can have thousands, from anti-aliased text, shadows and gradients. `quantize()` picks
 * the palette and `Palette.indexOf` maps any pixel onto it. When a frame has 256 colors or fewer,
 * as most interface screenshots do, they are kept exactly; past that, median cut gives the busiest
 * regions of color space the most palette entries.
 */

// Colors are bucketed at 5 bits a channel for median cut: 32768 buckets, small enough to sort.
const BUCKET_BITS = 5;
const BUCKETS = 1 << (BUCKET_BITS * 3);

/**
 * A palette of at most 256 colors, and the function that maps a color onto it.
 *
 * ```ts
 * import { quantize } from './quantize.ts';
 *
 * const palette: Palette = quantize([0xff0000, 0x0000ff], 256);
 * palette.colors.length; // 2
 * ```
 */
export interface Palette {
  /** `0xRRGGBB` per entry; an entry's position is its index in the GIF. */
  colors: number[];
  /** The index of the palette color nearest to `0xRRGGBB`. */
  indexOf(color: number): number;
}

/**
 * The pixels' own colors as a palette, when there are no more than `max` of them; null when there
 * are more, found out as soon as the count passes `max`.
 *
 * ```ts
 * import { exactPalette } from './quantize.ts';
 *
 * exactPalette([0x112233, 0xffffff, 0x112233], 255)?.colors; // [0x112233, 0xffffff]
 * exactPalette([1, 2, 3], 2); // null
 * ```
 */
export function exactPalette(pixels: ArrayLike<number>, max: number): Palette | null {
  const seen = new Set<number>();
  for (let index = 0; index < pixels.length; index++) {
    seen.add(pixels[index]);
    if (seen.size > max) return null;
  }
  const colors = [...seen];
  const indices = new Map(colors.map((color, index) => [color, index]));
  return { colors, indexOf: (color) => indices.get(color) ?? nearest(colors, color) };
}

/**
 * Picks at most `maxColors` colors for the given pixels (`0xRRGGBB` each).
 *
 * A screenshot of an interface usually has few distinct colors, and when there are no more than
 * `maxColors` they are kept exactly — no banding on text or borders. Past that, median cut over
 * 5-bit buckets: the bucket set is split, box by box, along its widest channel at the median
 * pixel, and each box becomes the average of the pixels in it.
 *
 * ```ts
 * import { quantize } from './quantize.ts';
 *
 * const exact = quantize([0x112233, 0x112233, 0xffffff], 256);
 * exact.colors; // [0x112233, 0xffffff]
 * exact.colors[exact.indexOf(0xffffff)] === 0xffffff; // true
 *
 * const gradient = Array.from({ length: 1024 }, (_, n) => n * 0x4001);
 * quantize(gradient, 16).colors.length <= 16; // true
 * ```
 */
export function quantize(pixels: ArrayLike<number>, maxColors: number): Palette {
  const exact = exactPalette(pixels, maxColors);
  if (exact) return exact;

  const counts = new Uint32Array(BUCKETS);
  const sums = new Float64Array(BUCKETS * 3);
  for (let index = 0; index < pixels.length; index++) {
    const color = pixels[index];
    const bucket = bucketOf(color);
    counts[bucket]++;
    sums[bucket * 3] += color >> 16;
    sums[bucket * 3 + 1] += (color >> 8) & 0xff;
    sums[bucket * 3 + 2] += color & 0xff;
  }
  const occupied = counts.reduce<number[]>((list, count, bucket) => {
    if (count) list.push(bucket);
    return list;
  }, []);
  const colors = medianCut(occupied, counts, maxColors).map((box) => average(box, counts, sums));
  // Most frames reuse a small share of the 32768 buckets, so nearest-color is worked out per
  // bucket on first use rather than for all of them up front.
  const lookup = new Int16Array(BUCKETS).fill(-1);
  return {
    colors,
    indexOf(color) {
      const bucket = bucketOf(color);
      if (lookup[bucket] === -1) lookup[bucket] = nearest(colors, color);
      return lookup[bucket];
    },
  };
}

// The distinct colors in order of first appearance, or null once there are more than `max`.

function medianCut(buckets: number[], counts: Uint32Array, maxColors: number): number[][] {
  const boxes = [buckets];
  for (
    let pick = bestBox(boxes, counts);
    pick !== -1 && boxes.length < maxColors;
    pick = bestBox(boxes, counts)
  ) {
    const box = boxes[pick];
    const { shift } = widest(box);
    box.sort((a, b) => ((a >> shift) & 31) - ((b >> shift) & 31));
    // Cut where the running count of pixels passes half the box's, keeping a bucket each side.
    const half = population(box, counts) / 2;
    let seen = 0;
    const cut = box.findIndex(
      (bucket, index) => index === box.length - 1 || (seen += counts[bucket]) > half,
    );
    boxes.splice(pick, 1, box.slice(0, Math.max(1, cut)), box.slice(Math.max(1, cut)));
  }
  return boxes;
}

// The box whose split buys the most — many pixels across a wide range of one channel — or -1
// when none has two buckets to split.
function bestBox(boxes: number[][], counts: Uint32Array): number {
  let pick = -1;
  let best = 0;
  boxes.forEach((box, index) => {
    const score = box.length < 2 ? 0 : population(box, counts) * widest(box).range;
    if (score > best) [pick, best] = [index, score];
  });
  return pick;
}

function widest(box: number[]): { shift: number; range: number } {
  return [10, 5, 0].reduce(
    (best, shift) => {
      let low = 31;
      let high = 0;
      for (const bucket of box) {
        const value = (bucket >> shift) & 31;
        if (value < low) low = value;
        if (value > high) high = value;
      }
      return high - low > best.range ? { shift, range: high - low } : best;
    },
    { shift: 10, range: -1 },
  );
}

function population(box: number[], counts: Uint32Array): number {
  return box.reduce((total, bucket) => total + counts[bucket], 0);
}

function average(box: number[], counts: Uint32Array, sums: Float64Array): number {
  let total = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  for (const bucket of box) {
    total += counts[bucket];
    red += sums[bucket * 3];
    green += sums[bucket * 3 + 1];
    blue += sums[bucket * 3 + 2];
  }
  return (
    (Math.round(red / total) << 16) | (Math.round(green / total) << 8) | Math.round(blue / total)
  );
}

function bucketOf(color: number): number {
  return ((color >> 19) << 10) | (((color >> 11) & 31) << 5) | ((color >> 3) & 31);
}

function nearest(colors: number[], color: number): number {
  const red = color >> 16;
  const green = (color >> 8) & 0xff;
  const blue = color & 0xff;
  let pick = 0;
  let best = Infinity;
  colors.forEach((candidate, index) => {
    const distance =
      ((candidate >> 16) - red) ** 2 +
      (((candidate >> 8) & 0xff) - green) ** 2 +
      ((candidate & 0xff) - blue) ** 2;
    if (distance < best) [pick, best] = [index, distance];
  });
  return pick;
}
