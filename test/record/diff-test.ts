import { module, test } from 'qunitx';
import { LAYOUT, compare, draw } from '../../lib/record/diff.ts';
import type { Image } from '../../lib/record/png.ts';

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

const pixel = (img: Image, x: number, y: number) => [
  ...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3),
];
// A pixel of the diff, by where it is in the BEFORE (0) or AFTER (1) screenshot of `width`.
const shown = (diff: Image, side: 0 | 1, width: number, x: number, y: number) =>
  pixel(diff, LAYOUT.gap + side * (width + LAYOUT.gap) + x, LAYOUT.label + y);
const OUTLINE = [232, 23, 93];

module('Record | diff', { concurrency: true }, () => {
  test('identical images have nothing changed and nothing boxed, both sides faded alike', (assert) => {
    const page = image(8, 8, (x) => (x < 4 ? 0x000000 : 0xffffff));
    const result = compare(page, page);
    const diff = draw(page, page, result);

    assert.deepEqual(
      [result.changedPixels, result.antialiasedPixels, result.totalPixels, result.regions],
      [0, 0, 64, []],
    );
    assert.true(result.sameSize);
    assert.deepEqual(
      [diff.width, diff.height],
      [2 * 8 + 3 * LAYOUT.gap, LAYOUT.label + 8 + LAYOUT.gap],
      'before and after side by side, framed, under their labels',
    );
    assert.true(shown(diff, 0, 8, 0, 0)[0] > 60, 'black faded toward the grey between');
    assert.deepEqual(shown(diff, 0, 8, 0, 0), shown(diff, 1, 8, 0, 0));
  });

  test('a change is boxed in the same place on both sides, each showing its own pixels', (assert) => {
    const before = image(40, 30, () => 0xffffff);
    const after = image(40, 30, (x, y) =>
      x >= 10 && x < 14 && y >= 10 && y < 13 ? 0x0044ff : 0xffffff,
    );
    const result = compare(before, after);
    const diff = draw(before, after, result);

    assert.equal(result.changedPixels, 12);
    assert.deepEqual(result.regions, [{ left: 6, top: 6, right: 17, bottom: 16 }], '4px of room');
    assert.deepEqual(shown(diff, 0, 40, 11, 11), [255, 255, 255], 'as it was');
    assert.deepEqual(shown(diff, 1, 40, 11, 11), [0, 68, 255], 'as it is, unfaded');
    assert.deepEqual(shown(diff, 0, 40, 5, 11), OUTLINE, 'the box, before');
    assert.deepEqual(shown(diff, 1, 40, 5, 11), OUTLINE, 'and after');
    assert.notDeepEqual(shown(diff, 1, 40, 30, 25), OUTLINE, 'nothing far from it');
  });

  test('changes close together are one box, and changes far apart are one each', (assert) => {
    const dots = (points: [number, number][]) =>
      image(120, 40, (x, y) =>
        points.some(([px, py]) => px === x && py === y) ? 0x000000 : 0xffffff,
      );
    const blank = image(120, 40, () => 0xffffff);

    assert.equal(
      compare(
        blank,
        dots([
          [10, 10],
          [14, 10],
          [18, 12],
        ]),
      ).regions.length,
      1,
    );
    assert.equal(
      compare(
        blank,
        dots([
          [10, 10],
          [100, 30],
        ]),
      ).regions.length,
      2,
    );
  });

  test('boxes that overlap once padded are one, even through a box joined in between', (assert) => {
    // A dot, then a dot, then an L: the L's box overlaps the second dot's, and the two joined
    // overlap the first dot's, which neither does alone.
    const ink = new Set(['100,33', '60,40']);
    for (let y = 48; y <= 90; y++) ink.add(`40,${y}`);
    for (let x = 40; x <= 95; x++) ink.add(`${x},90`);
    const blank = image(120, 100, () => 0xffffff);
    const marked = image(120, 100, (x, y) => (ink.has(`${x},${y}`) ? 0x000000 : 0xffffff));

    assert.deepEqual(compare(blank, marked).regions, [
      { left: 36, top: 29, right: 104, bottom: 94 },
    ]);
  });

  test('a shift smaller than the threshold is not a change, and the threshold is adjustable', (assert) => {
    const before = image(4, 4, () => 0x808080);
    const after = image(4, 4, () => 0x838383);

    assert.equal(compare(before, after).changedPixels, 0, 'within the default 0.1');
    assert.equal(compare(before, after, { threshold: 0 }).changedPixels, 16, 'any shift at 0');
  });

  test('anti-aliasing on the edge of a shape is told apart from a real change, and not boxed', (assert) => {
    // A black square on white, the same in both, except one edge pixel blended grey in the second:
    // what a renderer's font smoothing does from one run to the next.
    const square = (x: number, y: number) => x >= 4 && x < 10 && y >= 4 && y < 10;
    const before = image(14, 14, (x, y) => (square(x, y) ? 0x000000 : 0xffffff));
    const after = image(14, 14, (x, y) =>
      x === 10 && y === 6 ? 0x777777 : square(x, y) ? 0x000000 : 0xffffff,
    );
    const result = compare(before, after);

    assert.deepEqual([result.changedPixels, result.antialiasedPixels], [0, 1]);
    assert.deepEqual(result.regions, []);
  });

  test('a grey dot in the middle of a flat area is a change, not anti-aliasing', (assert) => {
    const before = image(9, 9, () => 0xffffff);
    const after = image(9, 9, (x, y) => (x === 4 && y === 4 ? 0x777777 : 0xffffff));

    assert.deepEqual(
      [compare(before, after).changedPixels, compare(before, after).antialiasedPixels],
      [1, 0],
    );
  });

  test('images of different sizes are wholly changed, drawn side by side at their own sizes', (assert) => {
    const [small, large] = [image(4, 4, () => 0), image(6, 5, () => 0xffffff)];
    const result = compare(small, large);
    const diff = draw(small, large, result);

    assert.deepEqual(
      [result.sameSize, result.changedPixels, result.totalPixels, result.regions],
      [false, 30, 30, []],
      'every pixel of the larger',
    );
    assert.deepEqual(
      [diff.width, diff.height],
      [4 + 6 + 3 * LAYOUT.gap, LAYOUT.label + 5 + LAYOUT.gap],
    );
    assert.deepEqual(shown(diff, 0, 4, 0, 0), [0, 0, 0], 'nothing faded');
  });

  test('transparent pixels are compared as they would show, over white', (assert) => {
    const clear = { width: 1, height: 1, data: Uint8Array.of(0, 0, 0, 0) };
    const white = image(1, 1, () => 0xffffff);

    assert.equal(compare(clear, white).changedPixels, 0);
  });
});
