/**
 * Tours: walkthroughs recorded from a script that drives a real browser — a cursor that moves,
 * clicks and types, a camera that zooms in on what matters, captions, and more than one tab.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as Capture from '../capture.ts';
import { NAVIGATION_TIMEOUT_MS } from '../../setup/browser.ts';
import {
  DEFAULT_LOOK,
  checkLook,
  compose,
  framedSize,
  type ComposedFrame,
  type ComposeOptions,
  type Frame,
  type Look,
  type Style,
} from './compose.ts';
import {
  menuItemPoint,
  menuLayout,
  Timeline,
  ease,
  frameCount,
  handLayout,
  pinchLayout,
  keyLabels,
  zoomedCamera,
  type Point,
  type Rect,
} from './timeline.ts';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';

export type { Point, Rect } from './timeline.ts';
export {
  CHROME_HEIGHT,
  DEFAULT_LOOK,
  framedSize,
  type Frame,
  type Look,
  type Style,
} from './compose.ts';

// How long each kind of step shows when the script does not say, in ms: long enough to follow,
// short enough not to drag.
const DEFAULTS = {
  move: 600,
  ripple: 350,
  afterClick: 400,
  afterHover: 400,
  perCharacter: 70,
  scroll: 700,
  drag: 700,
  zoom: 700,
  tab: 500,
  touchDown: 150,
  longPress: 600,
  menu: 700,
  pinch: 900,
  doubleClick: 120,
  press: 700,
  highlight: 300,
  chapter: 2000,
  chapterFade: 300,
} as const;
// Waits for the page to settle after a step: CSS animations and transitions that end, then two
// painted frames. Endless ones (spinners) are not waited for, or every step would time out.
const SETTLE = `(async () => {
  const finite = document.getAnimations().filter((animation) => {
    const end = animation.effect && animation.effect.getComputedTiming().endTime;
    return Number.isFinite(end);
  });
  await Promise.race([
    Promise.all(finite.map((animation) => animation.finished.catch(() => {}))),
    new Promise((done) => setTimeout(done, 1500)),
  ]);
  await new Promise((painted) => requestAnimationFrame(() => requestAnimationFrame(painted)));
})()`;

/**
 * Where a step points: a CSS selector (its first match, scrolled into view) or a point on the page.
 *
 * ```ts
 * const button: Target = '#checkout';
 * const corner: Target = { x: 20, y: 20 };
 * ```
 */
export type Target = string | Point;

/**
 * A context menu to draw after a right-click or long press, and the item to choose from it.
 *
 * ```ts
 * const options: MenuOptions = { menu: ['Copy', 'Paste', 'Delete'], choose: 'Paste' };
 * ```
 */
export interface MenuOptions {
  /** How long the press lasts (a long press), or the pointer's move to the target, in ms. */
  durationMs?: number;
  /** A long press with this many fingers, 1 to 10, side by side. Touch tours only. */
  fingers?: number;
  /** Items of a menu to draw over the frame. Without it, only what the page itself shows. */
  menu?: string[];
  /** An item of `menu` to move onto and choose. */
  choose?: string;
}

/**
 * A tab the tour opened, to switch back to or close.
 *
 * ```ts
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: a tab comes from `tour.open()`.
 * function titleOf(tab: TourTab): Promise<string> {
 *   return tab.page.title();
 * }
 * ```
 */
export interface TourTab {
  /** The Playwright page behind the tab, for anything the tour API does not cover. */
  readonly page: Page;
}

/**
 * What a tour script is handed. Every step happens in the real browser — clicks land, hovers
 * hover, typing types — and shows in the recording for its own `durationMs`, so the recording
 * plays the same however fast the machine ran it.
 *
 * ```ts
 * // Defined, not invoked: a tour script, as a `.tour.ts` file exports it.
 * async function checkout(tour: Tour) {
 *   await tour.goto('http://localhost:4200/');
 *   await tour.caption('Add something to the cart');
 *   await tour.click('button.add-to-cart');
 *   await tour.zoom('#cart', { scale: 2 });
 *   await tour.wait(1000);
 *   await tour.zoomOut();
 * }
 * ```
 */
export interface Tour {
  /** The active tab's page, for anything the tour API does not cover; call `snap()` after. */
  readonly page: Page;
  /** Every open tab, in strip order: `tabs[0]` is the one the tour started in. */
  readonly tabs: readonly TourTab[];
  /** Loads `url` in the active tab. */
  goto(url: string): Promise<void>;
  /** Moves the cursor onto `target` and clicks it; on a touch tour, taps it. */
  click(target: Target, options?: { durationMs?: number }): Promise<void>;
  /**
   * Taps `target` with a finger — or `fingers` of them, 1 to 10, side by side as a hand holds
   * them: a real touch on a touch tour, a click otherwise.
   */
  tap(target: Target, options?: { durationMs?: number; fingers?: number }): Promise<void>;
  /** Moves the cursor onto `target`, so its hover state shows. A touch screen has no hover. */
  hover(target: Target, options?: { durationMs?: number }): Promise<void>;
  /**
   * Right-clicks `target` for real: the page gets its `contextmenu` event, and a menu the page
   * draws itself is recorded as it is. `menu` draws one over the frame instead — an illustration,
   * not the browser's own, which a page never sees — and `choose` moves onto one of its items and
   * clicks it. On a touch screen, `longPress` is the equivalent.
   */
  rightClick(target: Target, options?: MenuOptions): Promise<void>;
  /**
   * Presses and holds `target` for `durationMs` of real time (600 ms unless given), so the page's
   * own long-press handling fires: a finger on a touch tour, the mouse button otherwise. `menu`
   * and `choose` work as for `rightClick`.
   */
  longPress(target: Target, options?: MenuOptions): Promise<void>;
  /**
   * Fingers on `target` — two, or up to 10 with `fingers`, evenly round a circle — spreading apart
   * (`scale` above 1) or closing in (below 1), and turning by `rotate` degrees as they go: a pinch,
   * a twist, or both, as real multi-touch input. Touch tours only.
   */
  pinch(
    target: Target,
    options?: { scale?: number; rotate?: number; fingers?: number; durationMs?: number },
  ): Promise<void>;
  /**
   * Glides the cursor to `target`, a selector or a point, or along a path of them one after
   * another (`[{ x: 100, y: 80 }, '#cart']`), in `durationMs` all told (600 per stop by default).
   * The real mouse moves with it, so whatever it passes over is hovered. Desktop tours only: a
   * finger shows only while it touches, so on a touch tour use `drag` or `swipe`.
   */
  move(target: Target | Target[], options?: { durationMs?: number }): Promise<void>;
  /** Two clicks in quick succession on `target`, or two taps on a touch tour: a real double click. */
  doubleClick(target: Target, options?: { durationMs?: number }): Promise<void>;
  /**
   * Clicks a `<select>` and picks `value` (an option's value or label). The browser's own option
   * list is never part of a page, so it is drawn, like a menu, and the pick made from it; several
   * values, for a `<select multiple>`, are picked without one.
   */
  select(
    target: string,
    value: string | string[],
    options?: { durationMs?: number },
  ): Promise<void>;
  /**
   * Clicks `target` — a file input, or a button that opens one — and gives it `files`, paths
   * relative to the tour file. The browser's file dialog is never drawn.
   */
  upload(
    target: string,
    files: string | string[],
    options?: { durationMs?: number },
  ): Promise<void>;
  /** Clicks `target`, then replaces whatever it holds with `text` at once. */
  fill(target: string, text: string): Promise<void>;
  /** Clicks `target`, then types `text` into it a character at a time. */
  type(target: Target, text: string, options?: { perCharacterMs?: number }): Promise<void>;
  /** Presses a key, or a combination such as `Control+A`, shown as a badge per key while it shows. */
  press(key: string, options?: { durationMs?: number }): Promise<void>;
  /**
   * Scrolls smoothly: by `{ x, y }` pixels (negative scrolls up or left), or until `target` is near
   * the top. `within` scrolls an element — a list, a sidebar — instead of the page. On a touch tour
   * a finger slides the other way, as a thumb pushes the page — or `fingers` of them, 1 to 10.
   */
  scroll(
    target: string | { x?: number; y?: number },
    options?: { durationMs?: number; within?: string; fingers?: number },
  ): Promise<void>;
  /**
   * Presses at `from`, moves to `to` and releases: with the mouse, or on a touch tour a finger —
   * or `fingers` of them, 1 to 10, in a row across the way they move.
   */
  drag(
    from: Target,
    to: Target,
    options?: { durationMs?: number; fingers?: number },
  ): Promise<void>;
  /** Drags across `target` in a direction, as a finger (or `fingers`) swipes a carousel or a sheet. */
  swipe(
    target: Target,
    direction: 'left' | 'right' | 'up' | 'down',
    options?: { distance?: number; durationMs?: number; fingers?: number },
  ): Promise<void>;
  /** Zooms the camera in on `target` so it fills `1 / scale` of the frame (default scale 2). */
  zoom(target: Target | Rect, options?: { scale?: number; durationMs?: number }): Promise<void>;
  /** Zooms back out to the whole page. */
  zoomOut(options?: { durationMs?: number }): Promise<void>;
  /** Shows `text` over the bottom of the frame from here on; null removes it. */
  caption(text: string | null): Promise<void>;
  /**
   * Lights up `target`, `padding` px around it (8 by default), and dims the rest of the frame from
   * here on, fading in. A second highlight moves there; null fades it out. A selector's highlight
   * follows it as `scroll` moves it; a point or a rect stays where it was put.
   */
  highlight(
    target: Target | Rect | null,
    options?: { padding?: number; durationMs?: number },
  ): Promise<void>;
  /**
   * A title card over the whole frame, between scenes: `title`, and an optional `subtitle`. It
   * fades in, holds and fades out, 2 seconds in all unless `durationMs` says otherwise.
   */
  chapter(title: string, options?: { subtitle?: string; durationMs?: number }): Promise<void>;
  /**
   * Starts a step: what follows, until the next, is one stop of the walkthrough, titled `title`
   * in the steps' panel and in the HTML player, which can jump to it. `notes` is shown beside it
   * in the player. A tour that never calls it is one step, named after its file.
   */
  step(title: string, options?: { notes?: string }): Promise<void>;
  /** Holds the frame as it is. */
  wait(durationMs: number): Promise<void>;
  /** Records the page as it moves on its own, in real time, for `durationMs`: animations, video. */
  live(durationMs: number): Promise<void>;
  /** Puts what the page shows now into the recording, after a change made through `page`. */
  snap(options?: { durationMs?: number }): Promise<void>;
  /** Opens `url` in a new tab and switches to it. The tab strip appears once there are two. */
  open(url: string): Promise<TourTab>;
  /** Switches to a tab. */
  switchTo(tab: TourTab): Promise<void>;
  /** Closes a tab, the active one by default, and switches to the one before it. */
  close(tab?: TourTab): Promise<void>;
}

/**
 * What a `.tour.ts` file exports by default: a script, with the options it records under.
 *
 * ```ts
 * const definition: TourDefinition = { options: { frame: 'browser' }, run: async () => {} };
 * ```
 */
export interface TourDefinition {
  /** How the tour is framed. */
  options: TourOptions;
  /** The script. */
  run: (tour: Tour) => Promise<void>;
}

/**
 * How a tour is framed.
 *
 * ```ts
 * const options: TourOptions = { touch: true, frame: 'phone' };
 * ```
 */
export interface TourOptions {
  /**
   * What the frames are drawn inside. `'browser'`: a desktop window with its tab strip and address
   * bar. `'phone'`: a phone with its address bar and a tab count. `'none'`: just the page.
   * `'auto'`, the default, is `'phone'` for a touch tour, `'browser'` once a tour opens a second
   * tab, and `'none'` otherwise. Decided for the whole recording: every frame is the same size.
   */
  frame?: 'auto' | Frame;
  /**
   * Whether the browser window or the phone shows its address bar. True by default; false draws
   * the window with its tabs only, and the phone as an app's screen, for a hybrid or installed app
   * whose users never see a URL.
   */
  addressBar?: boolean;
  /**
   * A phone or tablet instead of a desktop: the page gets touch input (and is a mobile page, except
   * in Firefox, which has no such mode), a fingertip replaces the cursor and shows only while it
   * touches, `click` and `tap` are real taps, `drag` and `swipe` are touch gestures, and `hover`
   * is refused. Pair it with a phone-sized viewport, `-w 390 -h 844`.
   */
  touch?: boolean;
  /**
   * The mouse cursor: its `size` (height in CSS pixels, 8–256, 28 by default), or an `image`
   * instead of the arrow — a path relative to the tour file, or a URL — whose `hotspot` is the
   * point it clicks with, from its top-left corner. The arrow is filled with `color` and outlined
   * with `stroke`: `style: { color: '#ffd43b', stroke: '#1d2433', strokeWidth: 2 }`.
   */
  cursor?: {
    size?: number;
    image?: string;
    hotspot?: { x: number; y: number };
    style?: Style;
  };
  /**
   * A fingertip on a touch tour: its `size` (diameter, 8–256, 44 by default), the `spacing`
   * between the fingers of a several-finger gesture (8–256, 1.15 × size by default), `labels` to
   * number them 1 to 10, and `style`. Each is a `.finger` with its `data-finger` number, for `css`.
   */
  finger?: { size?: number; spacing?: number; labels?: boolean; style?: Style };
  /** A click's or tap's ripple, drawn in its `color` (`style: { color: '#0c8' }`), or `false` for none. */
  ripple?: false | { style?: Style };
  /**
   * The caption: over the `'bottom'` (the default) or `'top'` of the page, or in the steps'
   * `'panel'` when the recording has one (`qunitx record --panel`), and its `style`.
   */
  caption?: { placement?: 'top' | 'bottom' | 'panel'; style?: Style };
  /**
   * How far `zoom` can go and stay sharp: screenshots are taken at this many device pixels per
   * CSS pixel. 2 by default, up to 4; higher costs memory and time on every step.
   */
  maxZoom?: number;
  /** A highlighted region's `style`: an outline, and a `boxShadow` that dims the rest. */
  highlight?: { style?: Style };
  /** The keystroke badges `press()` shows, bottom center: their `style`, or `false` for none. */
  keys?: false | { style?: Style };
  /** A chapter's title card: its `style` (`.title` and `.subtitle` are reached through `css`). */
  chapter?: { style?: Style };
  /** A drawn menu's `style`, and its highlighted item's `highlightStyle`. */
  menu?: { style?: Style; highlightStyle?: Style };
  /** The phone frame's `style` (its `background` is the bezel), and the CSS `backdrop` it sits on. */
  phone?: { backdrop?: string; style?: Style };
  /** The browser frame: its `theme`, `'light'` (the default) or `'dark'`, and `style`. */
  browser?: { theme?: 'light' | 'dark'; style?: Style };
  /**
   * A stylesheet for whatever the options above don't reach, added after the stage's own. It can
   * select `#caption`, `#highlight`, `#keys kbd`, `#chapter .title` and `.subtitle`, `#menu`,
   * `#menu .highlighted`, `#cursor`, `#cursor-image`, `.finger`,
   * `#ripple`, `#device` (the phone or window), `#chrome`, `.tab`, `.tab.active`, `#url`,
   * `#mobile-bar` and `#stage` (the page), and may `@import` a web font. `@keyframes` animations
   * run on the tour's clock, from when their part appears (a new caption restarts the caption's),
   * so they come out the same every time; transitions stay off.
   */
  css?: string;
}

/**
 * How a tour looks: its options laid over the defaults, sizes and choices checked, and a cursor
 * image's path made a `file:` URL (relative to `directory`, the tour file's own), for
 * {@link readCursorImage} to read. Whether the browser takes each CSS declaration is for `checkLook`.
 *
 * ```ts
 * import { lookOf } from './index.ts';
 *
 * lookOf({ cursor: { size: 40, style: { color: '#e03131' } } }, '/proj').cursor.size; // 40
 * lookOf({ ripple: false }, '/proj').ripple; // null
 * lookOf({ caption: { placement: 'top' } }, '/proj').caption.style; // {} — the stage's own CSS
 * ```
 */
export function lookOf(options: TourOptions, directory: string): Look {
  const size = (value: number | undefined, fallback: number, name: string) => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 8 || value > 256) {
      throw new Error(`${name} must be a number of CSS pixels from 8 to 256, not ${value}`);
    }
    return value;
  };
  const oneOf = <T extends string>(
    value: T | undefined,
    choices: T[],
    fallback: T,
    name: string,
  ): T => {
    if (value === undefined) return fallback;
    if (!choices.includes(value))
      throw new Error(
        `${name} must be ${choices
          .map((choice) => `'${choice}'`)
          .join(', ')
          .replace(/, ([^,]*)$/, ' or $1')}, not '${value}'`,
      );
    return value;
  };
  // Whether the browser takes each declaration is checked by checkLook, once it is up.
  const style = (value: Style | undefined, name: string): Style => {
    const declarations = definedOnly(value ?? {});
    for (const [property, entry] of Object.entries(declarations)) {
      if (typeof entry !== 'string' && typeof entry !== 'number')
        throw new Error(`${name}.${property} must be a string or a number, not ${typeof entry}`);
    }
    return declarations as Style;
  };
  const flag = (value: boolean | undefined, name: string): boolean => {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`${name} must be true or false, not ${JSON.stringify(value)}`);
    }
    return value ?? false;
  };
  const { cursor = {}, finger = {}, caption = {}, menu = {}, phone = {}, browser = {} } = options;
  const fallback = DEFAULT_LOOK;
  return {
    cursor: {
      image: cursor.image ? imageUrl(cursor.image, directory) : null,
      size: size(cursor.size, fallback.cursor.size, 'cursor.size'),
      hotspot: cursor.hotspot ?? (cursor.image ? { x: 0, y: 0 } : fallback.cursor.hotspot),
      style: style(cursor.style, 'cursor.style'),
    },
    finger: {
      size: size(finger.size, fallback.finger.size, 'finger.size'),
      spacing: finger.spacing === undefined ? null : size(finger.spacing, 0, 'finger.spacing'),
      labels: flag(finger.labels, 'finger.labels'),
      style: style(finger.style, 'finger.style'),
    },
    ripple:
      options.ripple === false ? null : { style: style(options.ripple?.style, 'ripple.style') },
    caption: {
      placement: oneOf(
        caption.placement,
        ['bottom', 'top', 'panel'],
        fallback.caption.placement,
        'caption.placement',
      ),
      style: style(caption.style, 'caption.style'),
    },
    highlight: { style: style(options.highlight?.style, 'highlight.style') },
    keys: options.keys === false ? null : { style: style(options.keys?.style, 'keys.style') },
    chapter: { style: style(options.chapter?.style, 'chapter.style') },
    menu: {
      style: style(menu.style, 'menu.style'),
      highlightStyle: style(menu.highlightStyle, 'menu.highlightStyle'),
    },
    phone: {
      backdrop: phone.backdrop ?? fallback.phone.backdrop,
      style: style(phone.style, 'phone.style'),
    },
    browser: {
      theme: oneOf(browser.theme, ['light', 'dark'], fallback.browser.theme, 'browser.theme'),
      style: style(browser.style, 'browser.style'),
    },
    css: options.css ?? '',
  };
}

// Keys set to undefined would otherwise spread over a default and erase it.
function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

// The image types a browser draws, by extension, for a cursor image read from disk.
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function imageUrl(image: string, directory: string): string {
  if (/^(data:|https?:\/\/)/i.test(image)) return image;
  const file = path.resolve(directory, image);
  if (!IMAGE_TYPES[path.extname(file).toLowerCase()]) {
    throw new Error(`cursor.image ${image}: expected a .png, .svg, .jpg, .webp or .gif`);
  }
  return pathToFileURL(file).href;
}

/**
 * `look` with a cursor image on disk read into a data URL, as the page that draws the tour takes
 * it; a URL or no image is left as it is.
 *
 * ```ts
 * import { DEFAULT_LOOK } from './compose.ts';
 * import { readCursorImage } from './index.ts';
 *
 * (await readCursorImage(DEFAULT_LOOK)).cursor.image; // null
 * ```
 */
export async function readCursorImage(look: Look): Promise<Look> {
  const { image } = look.cursor;
  if (!image?.startsWith('file:')) return look;
  const file = fileURLToPath(image);
  const bytes = await fs.promises.readFile(file).catch(() => {
    throw new Error(`cursor.image ${path.basename(file)}: no such file (${file})`);
  });
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  return {
    ...look,
    cursor: { ...look.cursor, image: `data:${type};base64,${bytes.toString('base64')}` },
  };
}

/**
 * The frame a tour is drawn in, once it has run: `'auto'` resolved by whether it touched and how
 * many tabs it opened.
 *
 * ```ts
 * import { resolveFrame } from './index.ts';
 *
 * resolveFrame({}, 1); // 'none'
 * resolveFrame({}, 2); // 'browser'
 * resolveFrame({ touch: true }, 1); // 'phone'
 * resolveFrame({ frame: 'none' }, 3); // 'none'
 * ```
 */
export function resolveFrame(options: TourOptions, openedTabs: number): Frame {
  const frame = options.frame ?? 'auto';
  if (frame !== 'auto') return frame;
  return options.touch ? 'phone' : openedTabs > 1 ? 'browser' : 'none';
}

/**
 * Declares a tour, for a `.tour.ts` file's default export. A plain `async (tour) => {}` works too;
 * this adds the types and the options.
 *
 * ```ts
 * import { tour } from './index.ts';
 *
 * const definition = tour({ touch: true }, async (t) => {
 *   await t.goto('http://localhost:4200/');
 *   await t.tap('#start');
 * });
 * definition.options.touch; // true
 * ```
 */
export function tour(run: TourDefinition['run']): TourDefinition;
/**
 * Declares a tour with options: `{ touch: true }` for a phone, `{ frame: 'browser' }` to always
 * draw a browser window.
 *
 * ```ts
 * import { tour } from './index.ts';
 *
 * tour({ frame: 'none' }, async () => {}).options.frame; // 'none'
 * ```
 */
export function tour(options: TourOptions, run: TourDefinition['run']): TourDefinition;
export function tour(
  first: TourOptions | TourDefinition['run'],
  second?: TourDefinition['run'],
): TourDefinition {
  return typeof first === 'function'
    ? { options: {}, run: first }
    : { options: first, run: second! };
}

/**
 * Loads a tour file and returns its definition, or a reason it is not one.
 *
 * ```ts
 * import { definitionOf } from './index.ts';
 *
 * const found = definitionOf({ default: async () => {} });
 * typeof found === 'string' ? found : found.options; // {}
 * typeof definitionOf({ default: 42 }); // 'string' — the reason
 * ```
 */
export function definitionOf(module: { default?: unknown }): TourDefinition | string {
  const exported = module.default;
  if (typeof exported === 'function')
    return { options: {}, run: exported as TourDefinition['run'] };
  if (exported && typeof (exported as TourDefinition).run === 'function') {
    return {
      options: (exported as TourDefinition).options ?? {},
      run: (exported as TourDefinition).run,
    };
  }
  return 'it must export default an async function, or tour(...) from qunitx-cli';
}

/**
 * A tour once it has run: its last page and context (for stills), its steps (a null title for
 * whoever recorded it to name), the size its frames are drawn at, and `draw` to draw them, onto a
 * bigger `canvas`, with a steps `panel`, or as jpeg for a player. `css` goes under the tour's own.
 *
 * ```ts
 * import type { RecordedTour } from './index.ts';
 *
 * // Defined, not invoked: needs a recorded tour.
 * async function frames(tour: RecordedTour) {
 *   return (await tour.draw({ type: 'jpeg', quality: 80 })).length;
 * }
 * ```
 */
export interface RecordedTour {
  /** The tab it ended on, for stills. */
  page: Page;
  /** Its own browser context, for the caller to close. */
  context: BrowserContext;
  /** Its steps, in order; a null title for whoever recorded it to name. */
  steps: { title: string | null; notes: string | null }[];
  /** The size its frames are drawn at, frame included. */
  size: { width: number; height: number };
  /** Draws its frames. */
  draw: (
    extra?: Pick<ComposeOptions, 'canvas' | 'panel' | 'type' | 'quality' | 'backdrop'> & {
      css?: string;
    },
  ) => Promise<ComposedFrame[]>;
}

/**
 * Runs the tour in `file`, in a browser context of its own (touch is decided when a context is
 * made). Returns the tab it ended on, for stills of where it finished; `draw`, which composes the
 * frames; and the context, for the caller to close. Drawing is a separate step on purpose: it uses
 * another page of the same browser, and a still taken after it could show a page that lost focus.
 *
 * ```ts
 * import { recordTour } from './index.ts';
 * import type { Browser } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live browser.
 * async function run(browser: Browser) {
 *   const settings = { width: 1280, height: 720, scale: 1, fps: 10, lastFrameDurationMs: 1000, browser: 'chromium' as const };
 *   return await recordTour('/proj/demo.tour.ts', { browser, settings, prepare: async () => {} });
 * }
 * ```
 */
export async function recordTour(
  file: string,
  setup: {
    browser: Browser;
    settings: {
      width: number;
      height: number;
      scale: number;
      fps: number;
      lastFrameDurationMs: number;
      browser: 'chromium' | 'firefox' | 'webkit';
      /** Ms a page may take to load; unbounded when null or absent. */
      timeout?: number | null;
    };
    /** Readies every page the tour opens, as `record` readies its own. */
    prepare: (page: Page) => Promise<void>;
  },
): Promise<RecordedTour> {
  const definition = definitionOf(await import(pathToFileURL(file).href));
  if (typeof definition === 'string') throw new Error(`${file}: ${definition}`);
  const touch = definition.options.touch ?? false;
  // Checked before the browser does anything: a typo in a cursor image fails in a moment.
  const options = await readCursorImage(lookOf(definition.options, path.dirname(file)));
  const addressBar = definition.options.addressBar ?? true;
  if (typeof addressBar !== 'boolean') {
    throw new Error(`addressBar must be true or false, not ${JSON.stringify(addressBar)}`);
  }
  const context = await setup.browser.newContext({
    viewport: { width: setup.settings.width, height: setup.settings.height },
    // Shot at maxZoom× (2 by default) and drawn at the asked-for scale, so a zoom that far stays sharp.
    deviceScaleFactor: Math.max(maxZoomOf(definition.options), setup.settings.scale),
    hasTouch: touch,
    // Firefox has no mobile mode; touch input alone is what it can emulate.
    isMobile: touch && setup.settings.browser !== 'firefox',
  });
  try {
    const page = await context.newPage();
    // Its CSS too, by the browser that will draw it, before the tour spends any time running.
    const look = await checkLook(page, options);
    await setup.prepare(page);
    const spacing = look.finger.spacing ?? look.finger.size * 1.15;
    const run = new TourRun({ ...setup, file, context, page, touch, spacing });
    await run.start();
    await definition.run(run);
    await run.wait(setup.settings.lastFrameDurationMs);

    const viewport = { width: setup.settings.width, height: setup.settings.height };
    const frame = resolveFrame(definition.options, run.openedTabs);
    return {
      page: run.page,
      context,
      steps: run.timeline.steps,
      size: framedSize(frame, viewport, addressBar),
      draw: (extra = {}) =>
        compose(setup.browser, run.shots, run.timeline.beats, {
          viewport,
          scale: setup.settings.scale,
          frame,
          addressBar,
          pointer: touch ? 'finger' : 'cursor',
          look: extra.css ? { ...look, css: `${extra.css}\n${look.css}` } : look,
          fps: setup.settings.fps,
          prepare: setup.prepare,
          ...extra,
        }),
    };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

// One tour as it runs: the real pages, the screenshots taken so far, and the timeline of beats.
class TourRun implements Tour {
  readonly shots: Uint8Array[] = [];
  readonly timeline: Timeline;
  openedTabs = 1;
  readonly #setup: RunSetup;
  readonly #tabs: TourTab[];
  readonly #touchInput = new WeakMap<Page, TouchInput>();
  #highlighted: { target: string; padding: number } | null = null;
  #active: TourTab;

  constructor(setup: RunSetup) {
    this.#setup = setup;
    this.#active = { page: setup.page };
    this.#tabs = [this.#active];
    this.timeline = new Timeline(
      { width: setup.settings.width, height: setup.settings.height },
      setup.settings.fps,
      { titles: [''], active: 0, url: '' },
      setup.touch ? 'finger' : 'cursor',
    );
  }

  get page(): Page {
    return this.#active.page;
  }

  get tabs(): readonly TourTab[] {
    return [...this.#tabs];
  }

  // Reaching a page is bounded; its load event is bounded by --timeout alone, as `record`'s are.
  async #load(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: 'commit', timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForLoadState('load', { timeout: this.#setup.settings.timeout ?? 0 });
  }

  async start(): Promise<void> {
    await this.#shoot();
  }

  async goto(url: string): Promise<void> {
    await this.#load(this.page, url);
    await this.#shoot();
  }

  async click(target: Target, options: { durationMs?: number } = {}): Promise<void> {
    if (this.#setup.touch) return await this.tap(target, options);
    const point = await this.#moveTo(target, options.durationMs ?? DEFAULTS.move);
    await this.page.mouse.click(point.x, point.y);
    await this.page.waitForLoadState('load').catch(() => {});
    await this.#shoot();
    this.timeline.ripple(DEFAULTS.ripple);
    this.timeline.hold(DEFAULTS.afterClick);
  }

  async tap(
    target: Target,
    options: { durationMs?: number; fingers?: number } = {},
  ): Promise<void> {
    const count = this.#fingers('tap', options.fingers);
    if (!this.#setup.touch) return await this.click(target, options);
    // A finger doesn't travel on screen: it lands, presses, and lifts. Several land side by side.
    const point = await this.#pointOf(target);
    const points = this.#hand(point, count, -Math.PI / 2);
    this.#touching(points);
    this.timeline.hold(options.durationMs ?? DEFAULTS.touchDown);
    if (count === 1) {
      await this.page.touchscreen.tap(point.x, point.y);
    } else {
      const input = await this.#touchFor(this.page);
      await input.start(points);
      await input.end(points);
    }
    await this.page.waitForLoadState('load').catch(() => {});
    await this.#shoot();
    this.timeline.ripple(DEFAULTS.ripple);
    this.#touching([]);
    this.timeline.hold(DEFAULTS.afterClick);
  }

  async hover(target: Target, options: { durationMs?: number } = {}): Promise<void> {
    if (this.#setup.touch) {
      throw new Error('hover() has no meaning on a touch screen: tap, swipe or scroll instead');
    }
    await this.#moveTo(target, options.durationMs ?? DEFAULTS.move);
    this.timeline.hold(DEFAULTS.afterHover);
  }

  async move(target: Target | Target[], options: { durationMs?: number } = {}): Promise<void> {
    if (this.#setup.touch) {
      throw new Error('move() has no finger to show on a touch screen: drag or swipe instead');
    }
    const stops = Array.isArray(target) ? target : [target];
    if (!stops.length)
      throw new Error('move() needs somewhere to go: a selector, a point, or a path');
    const each = (options.durationMs ?? DEFAULTS.move * stops.length) / stops.length;
    for (const stop of stops) await this.#moveTo(stop, each);
  }

  async doubleClick(target: Target, options: { durationMs?: number } = {}): Promise<void> {
    const point = this.#setup.touch
      ? await this.#pointOf(target)
      : await this.#moveTo(target, options.durationMs ?? DEFAULTS.move);
    if (this.#setup.touch) {
      this.timeline.pointerAt(point);
      await this.page.touchscreen.tap(point.x, point.y);
      await this.page.touchscreen.tap(point.x, point.y);
    } else {
      await this.page.mouse.dblclick(point.x, point.y);
    }
    // Two quick ripples, one after the other, as the two presses were.
    this.timeline.ripple(DEFAULTS.doubleClick);
    this.timeline.ripple(DEFAULTS.doubleClick);
    await this.#shoot();
    this.timeline.ripple(DEFAULTS.ripple);
    if (this.#setup.touch) this.timeline.pointerAt(null);
    this.timeline.hold(DEFAULTS.afterClick);
  }

  async select(
    target: string,
    value: string | string[],
    options: { durationMs?: number } = {},
  ): Promise<void> {
    const locator = this.page.locator(target).first();
    const choices: { value: string; label: string }[] = await locator.evaluate((element) =>
      Array.from(
        (element as unknown as { options?: ArrayLike<{ value: string; label: string }> }).options ??
          [],
        ({ value, label }) => ({ value, label }),
      ),
    );
    if (!choices.length) throw new Error(`select() needs a <select>, and ${target} has no options`);
    const values = [value].flat();
    const missing = values.find((wanted) => !choices.some((choice) => matches(choice, wanted)));
    if (missing !== undefined) {
      throw new Error(
        `"${missing}" is not an option of ${target}: ${choices.map(({ label }) => `"${label}"`).join(', ')}`,
      );
    }
    const box = await this.#boxOf(target);
    const point = { x: box.x + Math.min(box.width / 2, 40), y: box.y + box.height / 2 };
    if (this.#setup.touch) {
      this.timeline.pointerAt(point);
      this.timeline.hold(DEFAULTS.touchDown);
    } else {
      this.timeline.move(point, options.durationMs ?? DEFAULTS.move);
      await this.page.mouse.move(point.x, point.y);
    }
    this.timeline.ripple(DEFAULTS.ripple);
    const pick = () => locator.selectOption(values.map((wanted) => pickOf(choices, wanted)));
    if (values.length > 1) {
      await pick();
      await this.#shoot();
      if (this.#setup.touch) this.timeline.pointerAt(null);
      this.timeline.hold(DEFAULTS.afterClick);
      return;
    }
    // A long list shows the eight options around the chosen one, as a scrolled list would.
    const chosen = choices.findIndex((choice) => matches(choice, values[0]));
    const first = Math.max(0, Math.min(chosen - 3, choices.length - 8));
    const shown = choices.slice(first, first + 8).map(({ label }) => label);
    if (this.#setup.touch) this.timeline.pointerAt(null);
    await this.#menu(
      { x: box.x, y: box.y + box.height - 4 },
      { menu: shown, choose: choices[chosen].label, width: Math.max(box.width, 120) },
      async () => {
        await pick();
        await this.#shoot();
      },
    );
  }

  async upload(
    target: string,
    files: string | string[],
    options: { durationMs?: number } = {},
  ): Promise<void> {
    const directory = path.dirname(this.#setup.file);
    const paths = [files].flat().map((file) => path.resolve(directory, file));
    const present = await Promise.all(
      paths.map((file) =>
        fs.promises.access(file).then(
          () => true,
          () => false,
        ),
      ),
    );
    const absent = paths[present.indexOf(false)];
    if (absent) throw new Error(`upload() ${absent}: no such file`);
    const chooser = this.page.waitForEvent('filechooser', { timeout: 5000 });
    // The click is what a person does; whatever input it opens gets the files.
    await Promise.all([chooser.catch(() => {}), this.click(target, options)]);
    const opened = await chooser.catch(() => null);
    if (!opened) throw new Error(`upload() ${target}: clicking it opened no file chooser`);
    await opened.setFiles(paths);
    await this.#shoot();
    this.timeline.hold(DEFAULTS.afterClick);
  }

  async fill(target: string, text: string): Promise<void> {
    await this.click(target);
    await this.page.locator(target).first().fill(text);
    await this.#shoot();
    this.timeline.hold(DEFAULTS.afterClick);
  }

  async rightClick(target: Target, options: MenuOptions = {}): Promise<void> {
    if (this.#setup.touch) {
      throw new Error('a touch screen has no right-click: longPress() is its context menu');
    }
    const point = await this.#moveTo(target, options.durationMs ?? DEFAULTS.move);
    await this.page.mouse.click(point.x, point.y, { button: 'right' });
    await this.#shoot();
    this.timeline.ripple(DEFAULTS.ripple);
    await this.#menu(point, options);
  }

  async longPress(target: Target, options: MenuOptions = {}): Promise<void> {
    const count = this.#fingers('longPress', options.fingers);
    const point = await this.#pointOf(target);
    const holdMs = options.durationMs ?? DEFAULTS.longPress;
    if (this.#setup.touch) {
      const input = await this.#touchFor(this.page);
      const points = this.#hand(point, count, -Math.PI / 2);
      this.#touching(points);
      await input.start(points);
      // Real time, not tour time: the page's own long-press timer has to run out.
      await this.page.waitForTimeout(holdMs);
      await this.#shoot();
      this.timeline.ripple(holdMs);
      await input.end(points);
    } else {
      await this.#moveTo(point, DEFAULTS.move);
      await this.page.mouse.down();
      await this.page.waitForTimeout(holdMs);
      await this.#shoot();
      this.timeline.ripple(holdMs);
      await this.page.mouse.up();
    }
    await this.#shoot();
    await this.#menu(point, options);
    if (this.#setup.touch && !options.menu) this.#touching([]);
  }

  async pinch(
    target: Target,
    options: { scale?: number; rotate?: number; fingers?: number; durationMs?: number } = {},
  ): Promise<void> {
    if (!this.#setup.touch) throw new Error('pinch() takes two fingers: it needs a touch tour');
    const count = options.fingers ?? 2;
    if (!Number.isInteger(count) || count < 2 || count > 10) {
      throw new Error(`pinch() takes 2 to 10 fingers, not ${count}`);
    }
    const scale = options.scale ?? 2;
    if (!(scale > 0)) throw new Error(`pinch() scale must be above 0, not ${scale}`);
    const rotate = ((options.rotate ?? 0) * Math.PI) / 180;
    if (!Number.isFinite(rotate))
      throw new Error(`pinch() rotate must be degrees, not ${options.rotate}`);
    const box = await this.#boxOf(target);
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    // The fingers start a quarter of the target apart (never closer than they can stand), round
    // its center, and end that times `scale` apart, turned by `rotate`.
    const from = Math.max(this.#setup.spacing / 2, Math.min(box.width, box.height) * 0.125);
    const input = await this.#touchFor(this.page);
    const durationMs = options.durationMs ?? DEFAULTS.pinch;
    const steps = frameCount(durationMs, this.#setup.settings.fps);
    let at = pinchLayout(centre, count, from, 0);
    this.#touching(at);
    this.timeline.hold(DEFAULTS.touchDown);
    await input.start(at);
    for (let step = 1; step <= steps; step++) {
      const progress = ease(step / steps);
      at = pinchLayout(centre, count, from * (1 + (scale - 1) * progress), rotate * progress);
      await input.move(at);
      await this.#shoot({ settle: false });
      this.#touching(at);
      this.timeline.hold(durationMs / steps);
    }
    await input.end(at);
    await this.#shoot();
    this.#touching([]);
    this.timeline.hold(DEFAULTS.afterHover);
  }

  // The drawn menu after a right-click or long press, and the item chosen from it.
  async #menu(
    at: Point,
    options: MenuOptions & { width?: number },
    chosen?: () => Promise<void>,
  ): Promise<void> {
    if (!options.menu) {
      this.timeline.hold(DEFAULTS.afterClick);
      return;
    }
    const menu = menuLayout(at, options.menu, this.timeline.viewport, options.width);
    this.timeline.menu(menu);
    this.timeline.hold(DEFAULTS.menu);
    if (options.choose === undefined) return;
    const index = options.menu.indexOf(options.choose);
    if (index === -1) throw new Error(`"${options.choose}" is not one of the menu's items`);
    const item = menuItemPoint(menu, index);
    if (this.#setup.touch) this.timeline.pointerAt(item);
    else this.timeline.move(item, DEFAULTS.move / 2);
    this.timeline.menu({ ...menu, highlighted: index });
    this.timeline.hold(DEFAULTS.touchDown * 2);
    this.timeline.ripple(DEFAULTS.ripple);
    await chosen?.();
    this.timeline.menu(null);
    if (this.#setup.touch) this.timeline.pointerAt(null);
    this.timeline.hold(DEFAULTS.afterClick);
  }

  async type(
    target: Target,
    text: string,
    options: { perCharacterMs?: number } = {},
  ): Promise<void> {
    await this.click(target);
    for (const character of text) {
      await this.page.keyboard.type(character);
      await this.#shoot();
      this.timeline.hold(options.perCharacterMs ?? DEFAULTS.perCharacter);
    }
  }

  async press(key: string, options: { durationMs?: number } = {}): Promise<void> {
    await this.page.keyboard.press(key);
    await this.page.waitForLoadState('load').catch(() => {});
    await this.#shoot();
    this.timeline.keys(keyLabels(key));
    this.timeline.hold(options.durationMs ?? DEFAULTS.press);
    this.timeline.keys(null);
  }

  async scroll(
    target: string | { x?: number; y?: number },
    options: { durationMs?: number; within?: string; fingers?: number } = {},
  ): Promise<void> {
    const count = this.#fingers('scroll', options.fingers);
    const delta =
      typeof target === 'string'
        ? { x: 0, y: await this.#distanceToTop(target, options.within) }
        : { x: target.x ?? 0, y: target.y ?? 0 };
    const container = options.within ? this.page.locator(options.within).first() : null;
    const area = container ? await this.#boxOf(options.within!) : this.timeline.viewport;
    const durationMs = options.durationMs ?? DEFAULTS.scroll;
    const steps = frameCount(durationMs, this.#setup.settings.fps);
    // On a touch screen a thumb pushes the page: it slides up to scroll down. Its travel is the
    // scroll's, capped to most of the area, since a long scroll is several flicks, not one.
    const reach = {
      x: Math.sign(delta.x) * Math.min(Math.abs(delta.x), area.width * 0.6),
      y: Math.sign(delta.y) * Math.min(Math.abs(delta.y), area.height * 0.6),
    };
    const thumb = {
      x: area.x + area.width / 2 + reach.x / 2,
      y: area.y + area.height / 2 + reach.y / 2,
    };
    // The fingers move against the scroll: up to scroll down. Lined up across that way.
    const angle = Math.atan2(-delta.y, -delta.x);
    const hand = (point: Point) => this.#hand(point, count, angle);
    if (this.#setup.touch) this.#touching(hand(thumb));
    let scrolled = { x: 0, y: 0 };
    for (let step = 1; step <= steps; step++) {
      // Eased, like a trackpad: the same curve the cursor and the camera move on.
      const progress = ease(step / steps);
      const next = { x: Math.round(delta.x * progress), y: Math.round(delta.y * progress) };
      const by = [next.x - scrolled.x, next.y - scrolled.y] as const;
      if (container) {
        await container.evaluate(
          (element, [x, y]) =>
            (element as unknown as { scrollBy(x: number, y: number): void }).scrollBy(x, y),
          by,
        );
      } else {
        await this.page.evaluate(`window.scrollBy(${by[0]}, ${by[1]})`);
      }
      scrolled = next;
      await this.#followHighlight();
      await this.#shoot({ settle: false });
      if (this.#setup.touch) {
        this.#touching(hand({ x: thumb.x - reach.x * progress, y: thumb.y - reach.y * progress }));
      }
      this.timeline.hold(durationMs / steps);
    }
    if (this.#setup.touch) this.#touching([]);
    await this.#shoot();
  }

  async drag(
    from: Target,
    to: Target,
    options: { durationMs?: number; fingers?: number } = {},
  ): Promise<void> {
    const count = this.#fingers('drag', options.fingers);
    if (this.#setup.touch)
      return await this.#touchDrag(from, to, options.durationMs ?? DEFAULTS.drag, count);
    const start = await this.#moveTo(from, DEFAULTS.move);
    const end = await this.#pointOf(to);
    await this.page.mouse.down();
    const durationMs = options.durationMs ?? DEFAULTS.drag;
    const steps = frameCount(durationMs, this.#setup.settings.fps);
    for (let step = 1; step <= steps; step++) {
      const progress = ease(step / steps);
      const at = {
        x: start.x + (end.x - start.x) * progress,
        y: start.y + (end.y - start.y) * progress,
      };
      await this.page.mouse.move(at.x, at.y);
      await this.#shoot({ settle: false });
      this.timeline.move(at, durationMs / steps);
    }
    await this.page.mouse.up();
    await this.#shoot();
    this.timeline.hold(DEFAULTS.afterHover);
  }

  async swipe(
    target: Target,
    direction: 'left' | 'right' | 'up' | 'down',
    options: { distance?: number; durationMs?: number; fingers?: number } = {},
  ): Promise<void> {
    this.#fingers('swipe', options.fingers);
    const box = await this.#boxOf(target);
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const horizontal = direction === 'left' || direction === 'right';
    const distance = options.distance ?? (horizontal ? box.width : box.height) * 0.4;
    const sign = direction === 'left' || direction === 'up' ? -1 : 1;
    const from = horizontal
      ? { x: centre.x - (sign * distance) / 2, y: centre.y }
      : { x: centre.x, y: centre.y - (sign * distance) / 2 };
    const to = horizontal
      ? { x: centre.x + (sign * distance) / 2, y: centre.y }
      : { x: centre.x, y: centre.y + (sign * distance) / 2 };
    await this.drag(from, to, { durationMs: options.durationMs, fingers: options.fingers });
  }

  async zoom(
    target: Target | Rect,
    options: { scale?: number; durationMs?: number } = {},
  ): Promise<void> {
    const box = isRect(target) ? target : await this.#boxOf(target);
    const camera = zoomedCamera(box, options.scale ?? 2, this.timeline.viewport);
    this.timeline.camera(camera, options.durationMs ?? DEFAULTS.zoom);
  }

  async highlight(
    target: Target | Rect | null,
    options: { padding?: number; durationMs?: number } = {},
  ): Promise<void> {
    const durationMs = options.durationMs ?? DEFAULTS.highlight;
    this.#highlighted = null;
    if (target === null) {
      this.timeline.highlight(null, durationMs);
      return;
    }
    const box = isRect(target) ? target : await this.#boxOf(target);
    const padding = options.padding ?? 8;
    this.timeline.highlight(padded(box, padding), durationMs);
    if (typeof target === 'string') this.#highlighted = { target, padding };
  }

  // A highlighted element stays lit where it is as the page scrolls it along.
  async #followHighlight(): Promise<void> {
    if (!this.#highlighted) return;
    const box = await this.page.locator(this.#highlighted.target).first().boundingBox();
    if (box) this.timeline.highlightAt(padded(box, this.#highlighted.padding));
  }

  step(title: string, options: { notes?: string } = {}): Promise<void> {
    if (typeof title !== 'string' || !title.trim()) {
      throw new Error('step() needs a title, which the panel and the player show');
    }
    this.timeline.step(title, options.notes ?? null);
    return Promise.resolve();
  }

  chapter(title: string, options: { subtitle?: string; durationMs?: number } = {}): Promise<void> {
    this.timeline.chapter(
      title,
      options.subtitle ?? null,
      options.durationMs ?? DEFAULTS.chapter,
      DEFAULTS.chapterFade,
    );
    return Promise.resolve();
  }

  zoomOut(options: { durationMs?: number } = {}): Promise<void> {
    this.timeline.camera(this.timeline.viewport, options.durationMs ?? DEFAULTS.zoom);
    return Promise.resolve();
  }

  caption(text: string | null): Promise<void> {
    this.timeline.caption(text);
    return Promise.resolve();
  }

  wait(durationMs: number): Promise<void> {
    this.timeline.hold(durationMs);
    return Promise.resolve();
  }

  async live(durationMs: number): Promise<void> {
    const capture = Capture.start(this.page, { fps: this.#setup.settings.fps });
    await this.page.waitForTimeout(durationMs);
    const shots = await capture.stop();
    for (const [index, shot] of shots.entries()) {
      this.timeline.show(this.#keep(shot.png), await this.#tabStrip());
      const next = shots[index + 1];
      this.timeline.hold(next ? next.atMs - shot.atMs : 1000 / this.#setup.settings.fps);
    }
  }

  async snap(options: { durationMs?: number } = {}): Promise<void> {
    await this.#shoot();
    this.timeline.hold(options.durationMs ?? 0);
  }

  async open(url: string): Promise<TourTab> {
    const page = await this.#setup.context.newPage();
    await this.#setup.prepare(page);
    await this.#load(page, url);
    const tab = { page };
    this.#tabs.push(tab);
    this.openedTabs = Math.max(this.openedTabs, this.#tabs.length);
    await this.switchTo(tab);
    return tab;
  }

  async switchTo(tab: TourTab): Promise<void> {
    if (!this.#tabs.includes(tab))
      throw new Error('that tab is closed, or was not opened by this tour');
    this.#active = tab;
    await tab.page.bringToFront();
    await this.#shoot();
    this.timeline.hold(DEFAULTS.tab);
  }

  async close(tab: TourTab = this.#active): Promise<void> {
    const index = this.#tabs.indexOf(tab);
    if (index === -1 || this.#tabs.length === 1)
      throw new Error('a tour keeps at least one tab open');
    this.#tabs.splice(index, 1);
    await tab.page.close();
    await this.switchTo(this.#tabs[Math.max(0, index - 1)]);
  }

  // Fingers press at `from`, slide to `to` and lift, as real touch input: frames along the way,
  // the fingertips drawn under them, side by side across the way they move.
  async #touchDrag(from: Target, to: Target, durationMs: number, count = 1): Promise<void> {
    const start = await this.#pointOf(from);
    const end = await this.#pointOf(to);
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const input = await this.#touchFor(this.page);
    let points = this.#hand(start, count, angle);
    this.#touching(points);
    this.timeline.hold(DEFAULTS.touchDown);
    await input.start(points);
    const steps = frameCount(durationMs, this.#setup.settings.fps);
    for (let step = 1; step <= steps; step++) {
      const progress = ease(step / steps);
      const at = {
        x: start.x + (end.x - start.x) * progress,
        y: start.y + (end.y - start.y) * progress,
      };
      points = this.#hand(at, count, angle);
      await input.move(points);
      await this.#shoot({ settle: false });
      this.#touching(points);
      this.timeline.hold(durationMs / steps);
    }
    await input.end(points);
    await this.#shoot();
    this.#touching([]);
    this.timeline.hold(DEFAULTS.afterHover);
  }

  // How many fingers a gesture asked for: 1 to 10, and more than one only on a touch tour.
  #fingers(gesture: string, fingers: number | undefined): number {
    const count = fingers ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      throw new Error(`${gesture}() takes 1 to 10 fingers, not ${fingers}`);
    }
    if (count > 1 && !this.#setup.touch) {
      throw new Error(`${gesture}() with ${count} fingers needs a touch tour`);
    }
    return count;
  }

  // `count` fingers round `point`, in a row across `angle`, the tour's spacing apart.
  #hand(point: Point, count: number, angle: number): Point[] {
    return handLayout(point, count, this.#setup.spacing, angle);
  }

  // The fingers on screen: the first drawn as the pointer, the rest as further touches.
  #touching(points: Point[]): void {
    this.timeline.pointerAt(points[0] ?? null);
    this.timeline.touchesAt(points.slice(1));
  }

  async #touchFor(page: Page): Promise<TouchInput> {
    let input = this.#touchInput.get(page);
    if (!input) {
      input =
        this.#setup.settings.browser === 'chromium'
          ? new CdpTouch(await page.context().newCDPSession(page))
          : new DispatchedTouch(page);
      this.#touchInput.set(page, input);
    }
    return input;
  }

  // Moves the real mouse and the drawn cursor onto `target` together, so hover states arrive with
  // the cursor. The frames on the way show the page as it was; the last shows it hovered.
  async #moveTo(target: Target, durationMs: number): Promise<Point> {
    const point = await this.#pointOf(target);
    await this.page.mouse.move(point.x, point.y, { steps: 8 });
    this.timeline.move(point, durationMs);
    await this.#shoot();
    return point;
  }

  async #pointOf(target: Target): Promise<Point> {
    if (typeof target !== 'string') return target;
    const box = await this.#boxOf(target);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  async #boxOf(target: Target): Promise<Rect> {
    if (typeof target !== 'string') return { ...target, width: 1, height: 1 };
    const locator = this.page.locator(target).first();
    const before = await this.page.evaluate<number>('window.scrollY');
    await locator.scrollIntoViewIfNeeded();
    if ((await this.page.evaluate<number>('window.scrollY')) !== before) await this.#shoot();
    const box = await locator.boundingBox();
    if (!box) throw new Error(`${target} is not on the page, or not visible`);
    return box;
  }

  // How far to scroll for `target` to sit near the top of the page, or of `within`.
  async #distanceToTop(target: string, within?: string): Promise<number> {
    const top = (selector: string) =>
      this.page
        .locator(selector)
        .first()
        .evaluate(
          (element) =>
            (
              element as unknown as { getBoundingClientRect(): { top: number } }
            ).getBoundingClientRect().top,
        );
    return within ? (await top(target)) - (await top(within)) - 16 : (await top(target)) - 80;
  }

  async #shoot(options: { settle?: boolean } = {}): Promise<void> {
    if (options.settle !== false) await this.page.evaluate(SETTLE).catch(() => {});
    const png = await this.page.screenshot({ type: 'png' });
    this.timeline.show(this.#keep(png), await this.#tabStrip());
  }

  // The same picture twice is one screenshot: holds and captions cost nothing to draw.
  #keep(png: Uint8Array): number {
    const last = this.shots.length - 1;
    if (last >= 0 && Buffer.from(this.shots[last]).equals(png)) return last;
    this.shots.push(png);
    return this.shots.length - 1;
  }

  async #tabStrip() {
    return {
      titles: await Promise.all(this.#tabs.map((tab) => tab.page.title().catch(() => ''))),
      active: this.#tabs.indexOf(this.#active),
      url: this.page.url(),
    };
  }
}

// What a TourRun is built from: `recordTour`'s setup, plus the context, page and mode it made.
type RunSetup = Parameters<typeof recordTour>[1] & {
  /** The tour file, which paths in it are relative to. */
  file: string;
  /** Between two fingers of a several-finger gesture, in CSS pixels. */
  spacing: number;
  context: BrowserContext;
  page: Page;
  touch: boolean;
};

// Fingers on the page: pressed, moved, lifted — one, or several at once for a pinch.
interface TouchInput {
  start(points: Point[]): Promise<void>;
  move(points: Point[]): Promise<void>;
  end(points: Point[]): Promise<void>;
}

// Chromium takes real touch input over CDP: pointer and touch events both, native scrolling, and as
// many fingers as there are points.
class CdpTouch implements TouchInput {
  readonly #session: CDPSession;

  constructor(session: CDPSession) {
    this.#session = session;
  }

  start(points: Point[]): Promise<void> {
    return this.#send('touchStart', points);
  }

  move(points: Point[]): Promise<void> {
    return this.#send('touchMove', points);
  }

  end(): Promise<void> {
    return this.#send('touchEnd', []);
  }

  async #send(type: string, points: Point[]): Promise<void> {
    await this.#session.send('Input.dispatchTouchEvent', {
      type: type as 'touchStart',
      touchPoints: points.map(({ x, y }, index) => ({ x, y, id: index })),
    });
  }
}

// Firefox and WebKit have no touch-move input to drive, so the events a touch makes are dispatched
// at the element under each finger: pointer events of type "touch" everywhere, one pointer per
// finger, and touch events where the engine lets a page construct one (Firefox does; WebKit's
// Touch constructor is illegal). What listens for them — carousels, sliders, sheets, pinch-zoom
// viewers — responds as to fingers; the browser's own scrolling does not, which is what `scroll()`
// is for.
class DispatchedTouch implements TouchInput {
  readonly #page: Page;

  constructor(page: Page) {
    this.#page = page;
  }

  start(points: Point[]): Promise<void> {
    return this.#dispatch('start', points);
  }

  move(points: Point[]): Promise<void> {
    return this.#dispatch('move', points);
  }

  end(points: Point[]): Promise<void> {
    return this.#dispatch('end', points);
  }

  async #dispatch(phase: 'start' | 'move' | 'end', points: Point[]): Promise<void> {
    await this.#page.evaluate(`(() => {
      const phase = ${JSON.stringify(phase)};
      const points = ${JSON.stringify(points)};
      const state = globalThis.__qunitxTouch ??= { targets: [] };
      if (phase === 'start') state.targets = points.map(({ x, y }) => document.elementFromPoint(x, y) || document.body);
      const pointer = { start: 'pointerdown', move: 'pointermove', end: 'pointerup' }[phase];
      points.forEach(({ x, y }, index) => {
        state.targets[index].dispatchEvent(new PointerEvent(pointer, { pointerId: index + 1, pointerType: 'touch',
          isPrimary: index === 0, clientX: x, clientY: y, buttons: phase === 'end' ? 0 : 1, bubbles: true, cancelable: true, composed: true }));
      });
      try {
        const touches = points.map(({ x, y }, index) => new Touch({ identifier: index + 1, target: state.targets[index],
          clientX: x, clientY: y, pageX: x + scrollX, pageY: y + scrollY }));
        const type = { start: 'touchstart', move: 'touchmove', end: 'touchend' }[phase];
        const down = phase === 'end' ? [] : touches;
        state.targets[0].dispatchEvent(new TouchEvent(type, { touches: down, targetTouches: down,
          changedTouches: touches, bubbles: true, cancelable: true, composed: true }));
      } catch {}
      if (phase === 'end') state.targets = [];
    })()`);
  }
}

function isRect(target: Target | Rect): target is Rect {
  return typeof target === 'object' && 'width' in target && 'height' in target;
}

// An option is asked for by its value or by the label it shows.
function matches(choice: { value: string; label: string }, wanted: string): boolean {
  return choice.value === wanted || choice.label === wanted;
}

function pickOf(choices: { value: string; label: string }[], wanted: string): string {
  return choices.find((choice) => matches(choice, wanted))!.value;
}

function padded(box: Rect, padding: number): Rect {
  return {
    x: box.x - padding,
    y: box.y - padding,
    width: box.width + 2 * padding,
    height: box.height + 2 * padding,
  };
}

// Checked like the look's sizes: a typo here would quietly cost memory on every screenshot.
function maxZoomOf(options: TourOptions): number {
  const zoom = options.maxZoom ?? 2;
  if (!Number.isFinite(zoom) || zoom < 1 || zoom > 4) {
    throw new Error(`maxZoom must be a number from 1 to 4, not ${zoom}`);
  }
  return zoom;
}
