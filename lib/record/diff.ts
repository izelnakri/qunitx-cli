import type { Image } from './png.ts';

// The largest YIQ distance two colors can be apart (black against white), which `threshold`
// is a fraction of.
const MAX_DELTA = 35215;
// How far apart the pixels of one change can be and still share a box: the letters of a word,
// the parts of a button.
const REACH = 8;
// Room around what changed, inside its box.
const PADDING = 4;
// How much of a pixel outside every box is kept; the rest fades into one grey, the two
// screenshots' average brightness, so a dark page stays dark, a light one light, and what did not
// change looks the same on both sides.
const FADE = 0.3;
const BORDER = Uint8Array.of(70, 78, 94, 255);
const FRAME = Uint8Array.of(31, 36, 48, 255);
const LABEL = Uint8Array.of(226, 230, 238, 255);
const OUTLINE = Uint8Array.of(232, 23, 93, 255);
const HALO = Uint8Array.of(255, 255, 255, 255);
// The labels' letters and digits in a 5×7 pixel font, a row of five bits a number, drawn twice
// the size.
const GLYPHS: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  O: [14, 17, 17, 17, 17, 17, 14],
  R: [30, 17, 17, 30, 20, 18, 17],
  T: [31, 4, 4, 4, 4, 4, 4],
  x: [0, 0, 17, 10, 4, 10, 17],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  0: [14, 17, 19, 21, 25, 17, 14],
  1: [4, 12, 4, 4, 4, 4, 14],
  2: [14, 17, 1, 2, 4, 8, 31],
  3: [31, 2, 4, 2, 1, 17, 14],
  4: [2, 6, 10, 18, 31, 2, 2],
  5: [31, 16, 30, 1, 1, 17, 14],
  6: [6, 8, 16, 30, 17, 17, 14],
  7: [31, 1, 2, 4, 8, 8, 8],
  8: [14, 17, 17, 14, 17, 17, 14],
  9: [14, 17, 17, 15, 1, 2, 12],
};
const GLYPH_SCALE = 2;

/**
 * Where a diff puts its two screenshots: `gap` pixels of frame around and between them, under a
 * band `label` pixels tall that names each one.
 *
 * ```ts
 * import { LAYOUT } from './diff.ts';
 *
 * 2 * 640 + 3 * LAYOUT.gap; // 1316 — the width of the diff of two 640-pixel-wide screenshots
 * ```
 */
export const LAYOUT = { gap: 12, label: 30 } as const;

/**
 * A rectangle of pixels, its edges included: where one change is.
 *
 * ```ts
 * const button: Box = { left: 20, top: 40, right: 139, bottom: 79 };
 * button.right - button.left + 1; // 120 — pixels across
 * ```
 */
export interface Box {
  /** The first column in, from the screenshot's left edge. */
  left: number;
  /** The first row in, from the screenshot's top edge. */
  top: number;
  /** The last column in. */
  right: number;
  /** The last row in. */
  bottom: number;
}

/**
 * How two images differ.
 *
 * ```ts
 * const result: Comparison = { changedPixels: 0, antialiasedPixels: 0, totalPixels: 4, sameSize: true, regions: [] };
 * result.changedPixels === 0; // true — nothing moved
 * ```
 */
export interface Comparison {
  /** Pixels whose color moved further than the threshold, not counting anti-aliasing. */
  changedPixels: number;
  /** Pixels that differ only the way anti-aliased edges do from one render to the next. */
  antialiasedPixels: number;
  /** Pixels compared: width × height, or the larger image's when the sizes differ. */
  totalPixels: number;
  /** False when the images are different sizes; nothing else is compared then. */
  sameSize: boolean;
  /**
   * Where it changed: the changed pixels grouped into boxes, those of one word or one button
   * together, with a few pixels of room. Empty when nothing changed, or the sizes differ.
   */
  regions: Box[];
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
 * compare(white, dotted).regions; // [{ left: 0, top: 0, right: 1, bottom: 0 }]
 * ```
 */
export function compare(
  baseline: Image,
  current: Image,
  { threshold = 0.1 }: { threshold?: number } = {},
): Comparison {
  if (baseline.width !== current.width || baseline.height !== current.height) {
    // Every pixel of the larger of the two.
    const totalPixels = Math.max(baseline.width * baseline.height, current.width * current.height);
    return {
      changedPixels: totalPixels,
      antialiasedPixels: 0,
      totalPixels,
      sameSize: false,
      regions: [],
    };
  }

  const totalPixels = baseline.width * baseline.height;
  const limit = MAX_DELTA * threshold ** 2;
  const changed = new Uint8Array(totalPixels);
  let changedPixels = 0;
  let antialiasedPixels = 0;
  // A pixel at a time, by the offset of its four bytes, which are the same in both images.
  for (let offset = 0; offset < baseline.data.length; offset += 4) {
    if (Math.abs(colorDelta(baseline.data, current.data, offset, offset, false)) <= limit) {
      continue;
    } else if (antialiased(baseline, offset, current) || antialiased(current, offset, baseline)) {
      antialiasedPixels++;
    } else {
      changedPixels++;
      changed[offset / 4] = 1;
    }
  }
  return {
    changedPixels,
    antialiasedPixels,
    totalPixels,
    sameSize: true,
    regions: boxesAround(changed, baseline.width, baseline.height),
  };
}

/**
 * The picture of a {@link compare} for a person to read: BEFORE and AFTER side by side, each
 * change boxed in the same place on both and shown as it is, everything else faded into one grey.
 * When the sizes differ, the two as they are, each labelled with its size.
 *
 * ```ts
 * import * as Diff from './diff.ts';
 *
 * const white = { width: 2, height: 1, data: Uint8Array.of(255, 255, 255, 255, 255, 255, 255, 255) };
 * const dotted = { width: 2, height: 1, data: Uint8Array.of(255, 255, 255, 255, 0, 0, 0, 255) };
 * Diff.draw(white, dotted, Diff.compare(white, dotted)).width; // 40 — the two, framed
 * ```
 */
export function draw(
  baseline: Image,
  current: Image,
  { sameSize, regions }: Pick<Comparison, 'sameSize' | 'regions'>,
): Image {
  // Without boxes, when the sizes differ, nothing fades.
  const boxes = sameSize ? regions : null;
  const { gap, label } = LAYOUT;
  const width = baseline.width + current.width + 3 * gap;
  const height = label + Math.max(baseline.height, current.height) + gap;
  const canvas = { width, height, data: new Uint8Array(width * height * 4) };
  fill(canvas, 0, 0, width - 1, height - 1, FRAME);
  const kept = boxes && keptPixels(boxes, baseline.width, baseline.height);
  const grey = averageBrightness([baseline, current]);
  [baseline, current].forEach((image, index) => {
    const left = gap + index * (baseline.width + gap);
    // A line around the screenshot, which a dark page would otherwise run into the frame with.
    fill(canvas, left - 1, label - 1, left + image.width, label + image.height, BORDER);
    paste(canvas, image, left, label, kept ? { kept, grey } : null);
    // Sizes are named when they differ, which is then the change.
    const name = index === 0 ? 'BEFORE' : 'AFTER';
    write(canvas, boxes ? name : `${name}  ${image.width}x${image.height}`, {
      left,
      top: (label - 7 * GLYPH_SCALE) / 2,
      right: left + image.width - 1,
    });
    boxes?.forEach((box) => outline(canvas, box, left, label));
  });
  return canvas;
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

// The changed pixels grouped into boxes a person can find: the image is cut into REACH-sized
// cells, changed cells that touch (corners included) are one change, boxed around its own pixels
// with PADDING of room, and boxes that padding makes overlap are one box.
function boxesAround(changed: Uint8Array, width: number, height: number): Box[] {
  const columns = Math.ceil(width / REACH);
  // Each changed cell, at its index, boxed around its changed pixels; undefined for the rest.
  const cells = new Array<Box | undefined>(columns * Math.ceil(height / REACH)).fill(undefined);
  changed.forEach((isChanged, pixel) => {
    if (!isChanged) return;
    const x = pixel % width;
    const y = (pixel - x) / width;
    const cell = Math.floor(y / REACH) * columns + Math.floor(x / REACH);
    const point = { left: x, top: y, right: x, bottom: y };
    cells[cell] = cells[cell] ? join(cells[cell], point) : point;
  });
  return cells
    .flatMap((box, cell) => (box ? [takeChange(cells, cell, columns)] : []))
    .map((box) => pad(box, width, height))
    .reduce(absorb, []);
}

// The change the cell at `start` is part of: it and every changed cell touching it, and those
// touching them, taken out of `cells` and joined into one box.
function takeChange(cells: (Box | undefined)[], start: number, columns: number): Box {
  let box = cells[start]!;
  cells[start] = undefined;
  const pending = [start];
  for (let cell = pending.pop(); cell !== undefined; cell = pending.pop()) {
    for (const next of cellsAround(cell, columns)) {
      const found = cells[next];
      if (found) {
        box = join(box, found);
        cells[next] = undefined;
        pending.push(next);
      }
    }
  }
  return box;
}

// The indexes of the up to eight cells around `cell` in a grid `columns` wide; a row above or below
// the grid is no cell anyone has.
function cellsAround(cell: number, columns: number): number[] {
  const column = cell % columns;
  const around: number[] = [];
  for (let row = -1; row <= 1; row++) {
    for (let side = Math.max(-1, -column); side <= Math.min(1, columns - 1 - column); side++) {
      if (row || side) around.push(cell + row * columns + side);
    }
  }
  return around;
}

// `box` added to `boxes`, which do not overlap: joined with each it overlaps, and with each the
// joined box then overlaps, so they still do not.
function absorb(boxes: Box[], box: Box): Box[] {
  const touching = boxes.filter((other) => overlap(other, box));
  return touching.length
    ? absorb(
        boxes.filter((other) => !touching.includes(other)),
        touching.reduce(join, box),
      )
    : [...boxes, box];
}

function pad(box: Box, width: number, height: number): Box {
  return {
    left: Math.max(box.left - PADDING, 0),
    top: Math.max(box.top - PADDING, 0),
    right: Math.min(box.right + PADDING, width - 1),
    bottom: Math.min(box.bottom + PADDING, height - 1),
  };
}

function join(a: Box, b: Box): Box {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

function overlap(a: Box, b: Box): boolean {
  return a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
}

// 1 for each pixel inside a box, which keeps its own color.
function keptPixels(boxes: Box[], width: number, height: number): Uint8Array {
  const kept = new Uint8Array(width * height);
  boxes.forEach(({ left, top, right, bottom }) => {
    for (let y = top; y <= bottom; y++) kept.fill(1, y * width + left, y * width + right + 1);
  });
  return kept;
}

// The brightness of every pixel of `images` on average, as they show over white.
function averageBrightness(images: Image[]): number {
  const pixels = images.reduce((count, { data }) => count + data.length / 4, 0);
  let sum = 0;
  for (const { data } of images) {
    for (let offset = 0; offset < data.length; offset += 4) sum += brightness(data, offset);
  }
  return pixels ? sum / pixels : 255;
}

// Copies `image` onto `canvas` at (`left`, `top`), blended over white as a browser shows it; with
// `fade`, a pixel outside every box keeps FADE of its color and takes the rest from `grey`.
function paste(
  canvas: Image,
  image: Image,
  left: number,
  top: number,
  fade: { kept: Uint8Array; grey: number } | null,
) {
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const from = (y * image.width + x) * 4;
      const to = ((top + y) * canvas.width + left + x) * 4;
      const faded = fade !== null && !fade.kept[from / 4];
      for (let channel = 0; channel < 3; channel++) {
        const value = overWhite(image.data, from, channel);
        canvas.data[to + channel] = faded ? fade.grey + (value - fade.grey) * FADE : value;
      }
      canvas.data[to + 3] = 255;
    }
  }
}

// A box drawn on the screenshot at (`left`, `top`): a 2-pixel line just outside it, and a white
// halo outside that, so it shows on dark pages and light ones.
function outline(canvas: Image, box: Box, left: number, top: number) {
  const [x0, y0, x1, y1] = [left + box.left, top + box.top, left + box.right, top + box.bottom];
  (
    [
      [3, HALO],
      [2, OUTLINE],
      [1, OUTLINE],
    ] as const
  ).forEach(([distance, color]) => {
    fill(canvas, x0 - distance, y0 - distance, x1 + distance, y0 - distance, color);
    fill(canvas, x0 - distance, y1 + distance, x1 + distance, y1 + distance, color);
    fill(canvas, x0 - distance, y0 - distance, x0 - distance, y1 + distance, color);
    fill(canvas, x1 + distance, y0 - distance, x1 + distance, y1 + distance, color);
  });
}

// Paints the rectangle from (x0, y0) to (x1, y1), edges included, as far as it lies on `canvas`:
// one row of `color` made, then copied onto each row.
function fill(canvas: Image, x0: number, y0: number, x1: number, y1: number, color: Uint8Array) {
  const [left, right] = [Math.max(x0, 0), Math.min(x1, canvas.width - 1)];
  if (left > right) return;
  const row = new Uint8Array((right - left + 1) * 4).map((_, index) => color[index % 4]);
  for (let y = Math.max(y0, 0); y <= Math.min(y1, canvas.height - 1); y++) {
    canvas.data.set(row, (y * canvas.width + left) * 4);
  }
}

// Writes `text` in the 5×7 font from (`left`, `top`), each font pixel GLYPH_SCALE pixels square,
// as far as `right`: a label never runs into the next screenshot's.
function write(
  canvas: Image,
  text: string,
  { left, top, right }: { left: number; top: number; right: number },
) {
  [...text].forEach((character, index) => {
    const x = left + index * 6 * GLYPH_SCALE;
    if (x + 5 * GLYPH_SCALE - 1 > right) return;
    GLYPHS[character].forEach((row, y) => {
      for (let bit = 0; bit < 5; bit++) {
        if (row & (16 >> bit)) {
          const [px, py] = [x + bit * GLYPH_SCALE, top + y * GLYPH_SCALE];
          fill(canvas, px, py, px + GLYPH_SCALE - 1, py + GLYPH_SCALE - 1, LABEL);
        }
      }
    });
  });
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
