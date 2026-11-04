import * as Outputs from './outputs.ts';
import type { RecordedFile } from './index.ts';
import type { Settings } from './options.ts';
import type { Page } from 'playwright-core';

/**
 * A JPEG's width and height in pixels, from its frame header.
 *
 * ```ts
 * import * as JPEG from './jpeg.ts';
 *
 * // SOI, then a baseline frame header for 2×3 pixels.
 * JPEG.getDimensions(Uint8Array.of(0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 3, 0, 2, 3)); // { width: 2, height: 3 }
 * ```
 */
export function getDimensions(jpeg: Uint8Array): { width: number; height: number } {
  // Marker to marker: a segment's length says where the next one starts.
  const next = (at: number) =>
    jpeg[at] === 0xff ? at + 2 + ((jpeg[at + 2] << 8) | jpeg[at + 3]) : at + 1;
  for (let at = 2; at + 9 < jpeg.length; at = next(at)) {
    const marker = jpeg[at + 1];
    // Any start-of-frame marker but the three that are not frames (DHT, JPG, DAC).
    if (
      jpeg[at] === 0xff &&
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        height: (jpeg[at + 5] << 8) | jpeg[at + 6],
        width: (jpeg[at + 7] << 8) | jpeg[at + 8],
      };
    }
  }
  throw new Error('not a JPEG: no frame header');
}

/**
 * Writes a JPEG of `page` as it is to `output`, at `quality`: the viewport, or the whole page with
 * `fullPage`, with each `mask` selector painted over, sized by the JPEG's own header. `scale: 'css'`
 * shoots one pixel per CSS pixel.
 *
 * ```ts
 * import * as JPEG from './jpeg.ts';
 * import type { Output } from './outputs.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live page.
 * async function shoot(page: Page, output: Output) {
 *   return (await JPEG.record(page, output, { fullPage: false, quality: 90, mask: [] })).bytes;
 * }
 * ```
 */
export async function record(
  page: Page,
  output: Outputs.Output,
  {
    fullPage,
    quality,
    mask,
    scale = 'device',
  }: Pick<Settings, 'fullPage' | 'quality' | 'mask'> & { scale?: 'css' | 'device' },
): Promise<RecordedFile> {
  const bytes = await page.screenshot({
    type: 'jpeg',
    fullPage,
    quality,
    scale,
    ...(mask.length ? { mask: mask.map((selector) => page.locator(selector)) } : {}),
  });
  return Outputs.write(output, bytes, { ...getDimensions(bytes), frames: 1 });
}
