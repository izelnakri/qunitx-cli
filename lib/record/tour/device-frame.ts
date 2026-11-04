import type { TourOptions } from './index.ts';

// What a tour's page is drawn inside: nothing, a desktop browser window with its tab strip and
// address bar, or a phone. Every frame of a recording is drawn at the one size this decides.

/**
 * Height of the browser frame drawn above the page — tab strip and address bar — in CSS pixels.
 *
 * ```ts
 * import * as DeviceFrame from './device-frame.ts';
 *
 * 720 + DeviceFrame.BROWSER_HEIGHT; // 794 — the height of a 1280×720 tour's frames in a browser window
 * ```
 */
export const BROWSER_HEIGHT = 74;

/**
 * The part of {@link BROWSER_HEIGHT} that is the tab strip; the rest is the address bar.
 *
 * ```ts
 * import * as DeviceFrame from './device-frame.ts';
 *
 * DeviceFrame.BROWSER_HEIGHT - DeviceFrame.TAB_STRIP_HEIGHT; // 38 — the address bar
 * ```
 */
export const TAB_STRIP_HEIGHT = 36;

/**
 * What a tour's frames are drawn inside: nothing, a desktop browser window with its tabs, or a
 * phone with its address bar.
 *
 * ```ts
 * import * as DeviceFrame from './device-frame.ts';
 *
 * const frame: DeviceFrame.Kind = 'phone';
 * ```
 */
export type Kind = 'none' | 'browser' | 'phone';

/**
 * A phone's parts, in CSS pixels: a dark bezel with rounded corners, an address bar above the
 * screen, and a margin of backdrop around it all so the rounded corners have something to round
 * against.
 *
 * ```ts
 * import * as DeviceFrame from './device-frame.ts';
 *
 * 2 * (DeviceFrame.PHONE.margin + DeviceFrame.PHONE.bezel); // 60 — added to the page's width
 * ```
 */
export const PHONE = { margin: 18, bezel: 12, bar: 44 } as const;

/**
 * The size of a tour's drawn frames, in CSS pixels, for a page of `viewport` inside `frame`, with
 * or without its address bar.
 *
 * ```ts
 * import * as DeviceFrame from './device-frame.ts';
 *
 * DeviceFrame.size('none', { width: 390, height: 844 }); // { width: 390, height: 844 }
 * DeviceFrame.size('browser', { width: 1280, height: 720 }); // { width: 1280, height: 794 }
 * DeviceFrame.size('browser', { width: 1280, height: 720 }, false); // { width: 1280, height: 756 } — tabs only
 * DeviceFrame.size('phone', { width: 390, height: 844 }); // { width: 450, height: 948 }
 * DeviceFrame.size('phone', { width: 390, height: 844 }, false); // { width: 450, height: 904 } — an app's screen
 * ```
 */
export function size(
  frame: Kind,
  viewport: { width: number; height: number },
  addressBar = true,
): { width: number; height: number } {
  if (frame === 'browser') {
    const chrome = addressBar ? BROWSER_HEIGHT : TAB_STRIP_HEIGHT;
    return { width: viewport.width, height: viewport.height + chrome };
  }
  if (frame === 'phone') {
    const around = 2 * (PHONE.margin + PHONE.bezel);
    const bar = addressBar ? PHONE.bar : 0;
    return { width: viewport.width + around, height: viewport.height + around + bar };
  }
  return viewport;
}

/**
 * The frame a tour is drawn in, once it has run: `'auto'` resolved by whether it touched and how
 * many tabs it opened.
 *
 * ```ts
 * import * as DeviceFrame from './device-frame.ts';
 *
 * DeviceFrame.resolve({}, 1); // 'none'
 * DeviceFrame.resolve({}, 2); // 'browser'
 * DeviceFrame.resolve({ touch: true }, 1); // 'phone'
 * DeviceFrame.resolve({ frame: 'none' }, 3); // 'none'
 * ```
 */
export function resolve(options: TourOptions, openedTabs: number): Kind {
  const frame = options.frame ?? 'auto';
  if (frame !== 'auto') return frame;
  return options.touch ? 'phone' : openedTabs > 1 ? 'browser' : 'none';
}

/**
 * The frame a tour is drawn in when that has to be known before it runs, as under `--live`, where
 * every frame is drawn at one size from the first: `'auto'` is the phone for a touch tour and
 * otherwise the browser window, since a tab could open at any step.
 *
 * ```ts
 * import * as DeviceFrame from './device-frame.ts';
 *
 * DeviceFrame.resolveBeforeRun({}); // 'browser'
 * DeviceFrame.resolveBeforeRun({ touch: true }); // 'phone'
 * DeviceFrame.resolveBeforeRun({ frame: 'none' }); // 'none'
 * ```
 */
export function resolveBeforeRun(options: TourOptions): Kind {
  const frame = options.frame ?? 'auto';
  if (frame !== 'auto') return frame;
  return options.touch ? 'phone' : 'browser';
}
