import type { Image } from './png.ts';

// The largest YIQ distance two colors can be apart (black against white), which `threshold`
// is a fraction of.
const MAX_DELTA = 35215;
// How a changed pixel and an anti-aliased one are painted in the diff.
const CHANGED = Uint8Array.of(255, 0, 0, 255);
const ANTIALIASED = Uint8Array.of(255, 255, 0, 255);

/**
 * How two images differ.
 *
 * ```ts
 * const result: Comparison = { changedPixels: 0, antialiasedPixels: 0, totalPixels: 4, sameSize: true, diff: null };
 * result.changedPixels === 0; // true — nothing moved
 * ```
 */
export interface Comparison {
  /** Pixels whose color moved further than the threshold, not counting anti-aliasing. */
  changedPixels: number;
  /** Pixels that differ only the way anti-aliased edges do from one render to the next. */
  antialiasedPixels: number;
  /** Pixels compared: width × height. */
  totalPixels: number;
  /** False when the images are different sizes; nothing else is compared then. */
  sameSize: boolean;
  /**
   * The baseline faded to grey, with changed pixels in red and anti-aliased ones in yellow. Null
   * when the sizes differ.
   */
  diff: Image | null;
}

/**
 * Compares two screenshots pixel by pixel, the way people see them.
 *
 * Colors are compared in YIQ, where brightness weighs more than hue, as it does to the eye, and a
 * pixel counts as changed when it moves further than `threshold` of the widest possible distance
 * (0.1 by default: tolerant of color-management rounding, strict about anything visible).
 * Anti-aliased edges are told apart from real changes: a pixel whose neighborhood says it sits on
 * the edge of a shape, in either image, is counted separately, because font smoothing and
 * subpixel positioning shift those from one render to the next without anything having changed.
 *
 * ```ts
 * import { compare } from './diff.ts';
 *
 * const white = { width: 2, height: 1, data: Uint8Array.of(255, 255, 255, 255, 255, 255, 255, 255) };
 * const dotted = { width: 2, height: 1, data: Uint8Array.of(255, 255, 255, 255, 0, 0, 0, 255) };
 * compare(white, white).changedPixels; // 0
 * compare(white, dotted).changedPixels; // 1
 * ```
 */
export function compare(
  baseline: Image,
  current: Image,
  { threshold = 0.1 }: { threshold?: number } = {},
): Comparison {
  const totalPixels = baseline.width * baseline.height;
  if (baseline.width !== current.width || baseline.height !== current.height) {
    return {
      changedPixels: totalPixels,
      antialiasedPixels: 0,
      totalPixels,
      sameSize: false,
      diff: null,
    };
  }

  const limit = MAX_DELTA * threshold ** 2;
  const diff = new Uint8Array(totalPixels * 4);
  let changedPixels = 0;
  let antialiasedPixels = 0;
  // A pixel at a time, by the offset of its four bytes, which are the same in all three images.
  for (let offset = 0; offset < diff.length; offset += 4) {
    if (Math.abs(colorDelta(baseline.data, current.data, offset, offset, false)) <= limit) {
      // Unchanged: the baseline, faded toward white so the red stands out.
      diff.fill(255 + (brightness(baseline.data, offset) - 255) * 0.1, offset, offset + 3);
      diff[offset + 3] = 255;
    } else if (antialiased(baseline, offset, current) || antialiased(current, offset, baseline)) {
      antialiasedPixels++;
      diff.set(ANTIALIASED, offset);
    } else {
      changedPixels++;
      diff.set(CHANGED, offset);
    }
  }
  return {
    changedPixels,
    antialiasedPixels,
    totalPixels,
    sameSize: true,
    diff: { width: baseline.width, height: baseline.height, data: diff },
  };
}

// Whether the pixel at `offset` in `image` sits on an anti-aliased edge: it has both a darker and
// a brighter neighbor, few neighbors equal to it, and the darkest or brightest of them belongs to a
// flat area in both images — the two sides of an edge, with this pixel blended between them.
function antialiased(image: Image, offset: number, other: Image): boolean {
  const { width, height, data } = image;
  const x = (offset / 4) % width;
  const y = (offset / 4 - x) / width;
  let equal = x === 0 || x === width - 1 || y === 0 || y === height - 1 ? 1 : 0;
  let darkest = 0;
  let brightest = 0;
  let darkestAt: number | null = null;
  let brightestAt: number | null = null;
  for (let ny = Math.max(y - 1, 0); ny <= Math.min(y + 1, height - 1); ny++) {
    for (let nx = Math.max(x - 1, 0); nx <= Math.min(x + 1, width - 1); nx++) {
      if (nx === x && ny === y) continue;
      const neighbor = (ny * width + nx) * 4;
      const delta = colorDelta(data, data, offset, neighbor, true);
      if (delta === 0) {
        if (++equal > 2) return false;
      } else if (delta < darkest) {
        darkest = delta;
        darkestAt = neighbor;
      } else if (delta > brightest) {
        brightest = delta;
        brightestAt = neighbor;
      }
    }
  }
  if (darkestAt === null || brightestAt === null) return false;
  return (
    (flat(image, darkestAt) && flat(other, darkestAt)) ||
    (flat(image, brightestAt) && flat(other, brightestAt))
  );
}

// Whether the pixel at `offset` has at least three neighbors exactly its color.
function flat(image: Image, offset: number): boolean {
  const { width, height, data } = image;
  const x = (offset / 4) % width;
  const y = (offset / 4 - x) / width;
  let equal = x === 0 || x === width - 1 || y === 0 || y === height - 1 ? 1 : 0;
  for (let ny = Math.max(y - 1, 0); ny <= Math.min(y + 1, height - 1); ny++) {
    for (let nx = Math.max(x - 1, 0); nx <= Math.min(x + 1, width - 1); nx++) {
      if (nx === x && ny === y) continue;
      if (sameColor(data, offset, data, (ny * width + nx) * 4) && ++equal > 2) return true;
    }
  }
  return false;
}

// Whether two pixels have exactly the same bytes.
function sameColor(a: Uint8Array, aOffset: number, b: Uint8Array, bOffset: number): boolean {
  return (
    a[aOffset] === b[bOffset] &&
    a[aOffset + 1] === b[bOffset + 1] &&
    a[aOffset + 2] === b[bOffset + 2] &&
    a[aOffset + 3] === b[bOffset + 3]
  );
}

// The squared YIQ distance between two pixels, negative when the second is brighter. With
// `brightnessOnly`, just the Y difference, which is what edge detection needs. Transparent pixels
// are blended over white first, as a browser would show them.
function colorDelta(
  a: Uint8Array,
  b: Uint8Array,
  aOffset: number,
  bOffset: number,
  brightnessOnly: boolean,
): number {
  // Most pixels of two screenshots are the same bytes: nothing to blend or weigh.
  if (sameColor(a, aOffset, b, bOffset)) return 0;
  const r1 = overWhite(a, aOffset, 0);
  const g1 = overWhite(a, aOffset, 1);
  const b1 = overWhite(a, aOffset, 2);
  const r2 = overWhite(b, bOffset, 0);
  const g2 = overWhite(b, bOffset, 1);
  const b2 = overWhite(b, bOffset, 2);
  if (r1 === r2 && g1 === g2 && b1 === b2) return 0;
  const y = yiqY(r1, g1, b1) - yiqY(r2, g2, b2);
  if (brightnessOnly) return y;
  const i = yiqI(r1, g1, b1) - yiqI(r2, g2, b2);
  const q = yiqQ(r1, g1, b1) - yiqQ(r2, g2, b2);
  const delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
  return y > 0 ? -delta : delta;
}

// A channel of the pixel at `offset`, blended over white by its alpha.
function overWhite(data: Uint8Array, offset: number, channel: number): number {
  return 255 + (data[offset + channel] - 255) * (data[offset + 3] / 255);
}

function brightness(data: Uint8Array, offset: number): number {
  return yiqY(overWhite(data, offset, 0), overWhite(data, offset, 1), overWhite(data, offset, 2));
}

function yiqY(r: number, g: number, b: number): number {
  return r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
}

function yiqI(r: number, g: number, b: number): number {
  return r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
}

function yiqQ(r: number, g: number, b: number): number {
  return r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
}
