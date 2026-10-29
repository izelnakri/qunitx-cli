import { module, test } from 'qunitx';
import { compare } from '../../lib/record/diff.ts';
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

module('Record | diff', { concurrency: true }, () => {
  test('identical images have nothing changed, and the diff is the baseline faded to grey', (assert) => {
    const page = image(8, 8, (x) => (x < 4 ? 0x000000 : 0xffffff));
    const result = compare(page, page);

    assert.deepEqual(
      [result.changedPixels, result.antialiasedPixels, result.totalPixels],
      [0, 0, 64],
    );
    assert.true(result.sameSize);
    assert.true(pixel(result.diff!, 0, 0)[0] > 220, 'black faded nearly to white');
  });

  test('a changed block is counted pixel for pixel and painted red where it is', (assert) => {
    const before = image(20, 20, () => 0xffffff);
    const after = image(20, 20, (x, y) =>
      x >= 5 && x < 9 && y >= 5 && y < 8 ? 0x0044ff : 0xffffff,
    );
    const result = compare(before, after);

    assert.equal(result.changedPixels, 12);
    assert.deepEqual(pixel(result.diff!, 6, 6), [255, 0, 0]);
    assert.notDeepEqual(pixel(result.diff!, 0, 0), [255, 0, 0]);
  });

  test('a shift smaller than the threshold is not a change, and the threshold is adjustable', (assert) => {
    const before = image(4, 4, () => 0x808080);
    const after = image(4, 4, () => 0x838383);

    assert.equal(compare(before, after).changedPixels, 0, 'within the default 0.1');
    assert.equal(compare(before, after, { threshold: 0 }).changedPixels, 16, 'any shift at 0');
  });

  test('anti-aliasing on the edge of a shape is told apart from a real change', (assert) => {
    // A black square on white, the same in both, except one edge pixel blended grey in the second:
    // what a renderer's font smoothing does from one run to the next.
    const square = (x: number, y: number) => x >= 4 && x < 10 && y >= 4 && y < 10;
    const before = image(14, 14, (x, y) => (square(x, y) ? 0x000000 : 0xffffff));
    const after = image(14, 14, (x, y) =>
      x === 10 && y === 6 ? 0x777777 : square(x, y) ? 0x000000 : 0xffffff,
    );
    const result = compare(before, after);

    assert.deepEqual([result.changedPixels, result.antialiasedPixels], [0, 1]);
    assert.deepEqual(pixel(result.diff!, 10, 6), [255, 255, 0], 'yellow, not red');
  });

  test('a grey dot in the middle of a flat area is a change, not anti-aliasing', (assert) => {
    const before = image(9, 9, () => 0xffffff);
    const after = image(9, 9, (x, y) => (x === 4 && y === 4 ? 0x777777 : 0xffffff));

    assert.deepEqual(
      [compare(before, after).changedPixels, compare(before, after).antialiasedPixels],
      [1, 0],
    );
  });

  test('images of different sizes are entirely changed, with no diff to draw', (assert) => {
    const result = compare(
      image(4, 4, () => 0),
      image(4, 5, () => 0),
    );

    assert.deepEqual([result.sameSize, result.changedPixels, result.diff], [false, 16, null]);
  });

  test('transparent pixels are compared as they would show, over white', (assert) => {
    const clear = { width: 1, height: 1, data: Uint8Array.of(0, 0, 0, 0) };
    const white = image(1, 1, () => 0xffffff);

    assert.equal(compare(clear, white).changedPixels, 0);
  });
});
