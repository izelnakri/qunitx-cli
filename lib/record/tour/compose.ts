import { DEFAULT_FPS } from '../options.ts';
import { progress } from '../progress.ts';
import type { Browser, Page } from 'playwright-core';
import type { Beat } from './timeline.ts';
import { PANEL_CSS, PANEL_SCRIPT, panelHTML, type Panel } from '../panel.ts';

/**
 * Height of the browser frame drawn above the page — tab strip and address bar — in CSS pixels.
 *
 * ```ts
 * import { CHROME_HEIGHT } from './compose.ts';
 *
 * 720 + CHROME_HEIGHT; // 794 — the height of a 1280×720 tour's frames in a browser window
 * ```
 */
export const CHROME_HEIGHT = 74;

// The part of the browser frame that is its tab strip; the rest is the address bar.
const TAB_STRIP_HEIGHT = 36;

/**
 * What a tour's frames are drawn inside: nothing, a desktop browser window with its tabs, or a
 * phone with its address bar.
 *
 * ```ts
 * const frame: Frame = 'phone';
 * ```
 */
export type Frame = 'none' | 'browser' | 'phone';

/**
 * How the pointer is drawn: a mouse cursor, always on screen, or a fingertip, only while it touches.
 *
 * ```ts
 * const pointer: Pointer = 'finger';
 * ```
 */
export type Pointer = 'cursor' | 'finger';

/**
 * CSS declarations, as a `style` attribute would hold them. Names are camelCase or kebab-case
 * (`borderRadius`, `border-radius`, `--accent`), and a bare number is pixels wherever CSS needs a
 * unit (`fontSize: 20`) and a number where it doesn't (`opacity: 0.8`, `lineHeight: 1.4`).
 * `undefined` leaves the default, as if the property weren't there.
 *
 * ```ts
 * const style: Style = { background: '#5f3dc4', borderRadius: 0, fontFamily: 'Georgia, serif' };
 * ```
 */
export type Style = { [property: string]: string | number | undefined };

/**
 * How a tour looks, resolved from its options. The defaults are the stage's own stylesheet; each
 * `style` here is laid over its part as inline CSS, so it wins over the stylesheet and over `css`.
 *
 * ```ts
 * import { DEFAULT_LOOK } from './compose.ts';
 *
 * const look: Look = { ...DEFAULT_LOOK, caption: { placement: 'top', style: { borderRadius: 0 } } };
 * look.caption.placement; // 'top'
 * ```
 */
export interface Look {
  /** The mouse cursor: `#cursor`, an `<svg>` whose arrow is filled with `color` and outlined with `stroke`. */
  cursor: {
    /** A URL (data:, http:) to an image drawn instead of the arrow, or null for the arrow. */
    image: string | null;
    /** Height in CSS pixels; an image keeps its aspect ratio. */
    size: number;
    /** The point of the cursor inside it, in CSS pixels from its top-left corner. */
    hotspot: { x: number; y: number };
    style: Style;
  };
  /** A fingertip on a touch tour: `.finger`, a circle with a border. */
  finger: {
    /** Diameter in CSS pixels. */
    size: number;
    /** Between the centers of two fingers of a several-finger gesture; null for 1.15 × size. */
    spacing: number | null;
    /** Number each fingertip, 1 to 10, as its `data-finger` is. */
    labels: boolean;
    style: Style;
  };
  /** A click's or tap's ripple, `#ripple`, ringed and filled in its `color`; null for none. */
  ripple: { style: Style } | null;
  /** The caption, `#caption`. */
  caption: {
    /** Over the top or the bottom of the page. */
    /** Over the top or bottom of the page, or in the steps' panel when there is one. */
    placement: 'top' | 'bottom' | 'panel';
    style: Style;
  };
  /** A lit-up region, `#highlight`: the box itself, whose `box-shadow` dims the rest. */
  highlight: { style: Style };
  /** Keystroke badges, `#keys`, one `<kbd>` per key; null shows none. */
  keys: { style: Style } | null;
  /** A title card, `#chapter`, with its `.title` and `.subtitle`. */
  chapter: { style: Style };
  /** A drawn menu, `#menu`, and its highlighted item, `#menu .highlighted`. */
  menu: { style: Style; highlightStyle: Style };
  /** The phone frame, `#device`, and the CSS `background` of what it sits on. */
  phone: { backdrop: string; style: Style };
  /** The browser frame, `#chrome`: light or dark tabs and address bar. */
  browser: { theme: 'light' | 'dark'; style: Style };
  /** A stylesheet for anything else: added after the stage's own, so it overrides its defaults. */
  css: string;
}

/**
 * How a tour looks unless it says otherwise.
 *
 * ```ts
 * import { DEFAULT_LOOK } from './compose.ts';
 *
 * DEFAULT_LOOK.finger.size; // 44 — about a real fingertip on a phone
 * DEFAULT_LOOK.caption.placement; // 'bottom'
 * ```
 */
export const DEFAULT_LOOK: Look = {
  cursor: { image: null, size: 28, hotspot: { x: 2, y: 2 }, style: {} },
  finger: { size: 44, spacing: null, labels: false, style: {} },
  ripple: { style: {} },
  caption: { placement: 'bottom', style: {} },
  highlight: { style: {} },
  keys: { style: {} },
  chapter: { style: {} },
  menu: { style: {}, highlightStyle: {} },
  phone: { backdrop: '#e8ebf0', style: {} },
  browser: { theme: 'light', style: {} },
  css: '',
};

/**
 * Checks CSS declarations against the browser's own CSS and returns them as it takes them, or
 * throws naming the first it will not: the rule every `style` option is held to. `part` names
 * them in the error; `as` checks every value as that one property.
 *
 * ```ts
 * import { checkStyle } from './compose.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live page.
 * async function check(page: Page) {
 *   return await checkStyle(page, 'panel.style', { fontSize: 18 }); // { 'font-size': '18px' }
 * }
 * ```
 */
export async function checkStyle(
  page: Page,
  part: string,
  style: Style,
  as?: string,
): Promise<Style> {
  const declarations = Object.entries(style).map(([name, value]) => ({
    name,
    property: as ?? kebabCase(name),
    value,
  }));
  // A string or the value as given if CSS takes it, else a number with px, else null; unknown
  // property names are told apart by not even taking 'initial'.
  const verdicts: (string | null | false)[] = await page.evaluate(
    `${JSON.stringify(declarations)}.map(({ property, value }) => !CSS.supports(property, 'initial')
      ? false
      : [String(value), value + 'px'].find((candidate, index) =>
          (index === 0 || typeof value === 'number') && CSS.supports(property, candidate)) ?? null)`,
  );
  return Object.fromEntries(
    declarations.map(({ name, property, value }, index) => {
      const verdict = verdicts[index];
      if (verdict === false) throw new Error(`${part}.${name} is not a CSS property`);
      if (verdict === null)
        throw new Error(`${part}.${name}: ${JSON.stringify(value)} is not a valid ${property}`);
      return [property, verdict];
    }),
  );
}

/**
 * Checks every declaration of a look against the browser's own CSS (see {@link checkStyle}) and
 * returns the look with each one as the browser takes it.
 *
 * ```ts
 * import { checkLook, DEFAULT_LOOK } from './compose.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live page.
 * async function check(page: Page) {
 *   const look = { ...DEFAULT_LOOK, caption: { placement: 'top' as const, style: { borderRadius: 0 } } };
 *   return (await checkLook(page, look)).caption.style; // { 'border-radius': '0' }
 * }
 * ```
 */
export async function checkLook(page: Page, look: Look): Promise<Look> {
  const check = (part: string, style: Style, as?: string) => checkStyle(page, part, style, as);
  return {
    ...look,
    cursor: { ...look.cursor, style: await check('cursor.style', look.cursor.style) },
    finger: { ...look.finger, style: await check('finger.style', look.finger.style) },
    ripple: look.ripple && { style: await check('ripple.style', look.ripple.style) },
    caption: { ...look.caption, style: await check('caption.style', look.caption.style) },
    highlight: { style: await check('highlight.style', look.highlight.style) },
    keys: look.keys && { style: await check('keys.style', look.keys.style) },
    chapter: { style: await check('chapter.style', look.chapter.style) },
    menu: {
      style: await check('menu.style', look.menu.style),
      highlightStyle: await check('menu.highlightStyle', look.menu.highlightStyle),
    },
    phone: {
      backdrop: String(
        (await check('phone', { backdrop: look.phone.backdrop }, 'background')).background,
      ),
      style: await check('phone.style', look.phone.style),
    },
    browser: { ...look.browser, style: await check('browser.style', look.browser.style) },
  };
}

// `borderRadius` → `border-radius`, `WebkitMask` → `-webkit-mask`; custom properties stay as named.
function kebabCase(name: string): string {
  return name.startsWith('--')
    ? name
    : name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

// A phone: a dark bezel with rounded corners, an address bar above the screen, and a margin of
// backdrop around it all so the rounded corners have something to round against.
const PHONE = { margin: 18, bezel: 12, bar: 44 } as const;

/**
 * The size of a tour's drawn frames, in CSS pixels, for a page of `viewport` inside `frame`, with
 * or without its address bar.
 *
 * ```ts
 * import { framedSize } from './compose.ts';
 *
 * framedSize('none', { width: 390, height: 844 }); // { width: 390, height: 844 }
 * framedSize('browser', { width: 1280, height: 720 }); // { width: 1280, height: 794 }
 * framedSize('browser', { width: 1280, height: 720 }, false); // { width: 1280, height: 756 } — tabs only
 * framedSize('phone', { width: 390, height: 844 }); // { width: 450, height: 948 }
 * framedSize('phone', { width: 390, height: 844 }, false); // { width: 450, height: 904 } — an app's screen
 * ```
 */
export function framedSize(
  frame: Frame,
  viewport: { width: number; height: number },
  addressBar = true,
): { width: number; height: number } {
  if (frame === 'browser') {
    const chrome = addressBar ? CHROME_HEIGHT : TAB_STRIP_HEIGHT;
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
 * One drawn frame: its image, how long it shows, and what it shows — which step of the whole
 * recording, and the caption — for a player to show beside it.
 *
 * ```ts
 * const frame: ComposedFrame = { image: new Uint8Array(0), durationMs: 100, step: 2, caption: 'Pay' };
 * ```
 */
export interface ComposedFrame {
  /** PNG, or JPEG when asked for. */
  image: Uint8Array;
  /** How long it shows. */
  durationMs: number;
  /** Its step among the whole recording's. */
  step: number;
  /** The caption to show beside it, when captions go in the panel; null otherwise. */
  caption: string | null;
}

/**
 * Draws each beat — a screenshot under the camera, the pointer, a tap or click's ripple, the
 * caption, inside the frame asked for — into a PNG, in an ordinary page of the same browser. Drawn
 * with HTML and CSS because that is what renders text, curves and shadows well, and because the
 * frames then look like the browser they came from.
 *
 * Done after the tour has run, so nothing here races the page being recorded: every beat is drawn
 * exactly as described, however long it takes.
 *
 * ```ts
 * import { compose } from './compose.ts';
 * import type { Browser } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live browser.
 * async function draw(browser: Browser, shots: Uint8Array[]) {
 *   return await compose(browser, shots, [], {
 *     viewport: { width: 390, height: 844 },
 *     scale: 1,
 *     frame: 'phone',
 *     pointer: 'finger',
 *   });
 * }
 * ```
 */
export async function compose(
  browser: Browser,
  shots: Uint8Array[],
  beats: Beat[],
  options: ComposeOptions,
): Promise<ComposedFrame[]> {
  const layout = layoutOf(options);
  const context = await browser.newContext({
    viewport: layout.size,
    deviceScaleFactor: options.scale,
  });
  try {
    const page = await context.newPage();
    await options.prepare?.(page);
    await page.setContent(stageHTML(options, layout));
    const given = options.look ?? DEFAULT_LOOK;
    const look = await checkLook(page, {
      ...given,
      phone: { ...given.phone, backdrop: options.backdrop ?? given.phone.backdrop },
    });
    // A panel the player draws for itself is not drawn here, but captions still go to it.
    const captionOutside = look.caption.placement === 'panel' && Boolean(options.panel);
    const panel = options.panel &&
      options.panel.drawn !== false && {
        ...options.panel,
        style: await checkStyle(page, 'panel.style', options.panel.style),
      };
    await page.evaluate(
      `globalThis.__configure(${JSON.stringify({ ...look, panel: panel || null, captionOutside })})`,
    );
    for (const [index, shot] of shots.entries()) {
      await page.evaluate(
        `globalThis.__load(${index}, ${JSON.stringify(Buffer.from(shot).toString('base64'))})`,
      );
    }
    const frames: ComposedFrame[] = [];
    const step = 1000 / (options.fps ?? DEFAULT_FPS);
    const offset = options.panel?.offset ?? 0;
    const shoot = () =>
      options.type === 'jpeg'
        ? page.screenshot({ type: 'jpeg', quality: options.quality ?? 90 })
        : page.screenshot({ type: 'png' });
    let atMs = 0;
    // How far along the drawing is, for the phase the caller entered; a recording of steps draws
    // its parts one by one, each from the start.
    progress.done = 0;
    progress.total = beats.length;
    for (const beat of beats) {
      await page.evaluate(`globalThis.__show(${JSON.stringify(beat)}, ${atMs})`);
      const about = { step: offset + beat.step, caption: captionOutside ? beat.caption : null };
      // A held beat is one frame, unless a CSS animation is still moving: then one per tick
      // until it stops, each drawn at its exact time on the tour's clock.
      let shownMs = 0;
      for (;;) {
        const image = await shoot();
        const moving =
          shownMs + step < beat.durationMs &&
          (await page.evaluate<boolean>(`globalThis.__tick(${atMs + shownMs + step}, ${step})`));
        if (!moving) {
          frames.push({ image, durationMs: beat.durationMs - shownMs, ...about });
          break;
        }
        frames.push({ image, durationMs: step, ...about });
        shownMs += step;
      }
      atMs += beat.durationMs;
      progress.done += 1;
    }
    return frames;
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * How {@link compose} draws a tour's beats: the page's size and scale, the frame and pointer, the
 * look, and where the frame sits in a recording of several parts.
 *
 * ```ts
 * const options: ComposeOptions = { viewport: { width: 390, height: 844 }, scale: 1, frame: 'phone', pointer: 'finger' };
 * ```
 */
export interface ComposeOptions {
  /** The page's size in CSS pixels. */
  viewport: { width: number; height: number };
  /** Device pixels per CSS pixel of the drawn frames. */
  scale: number;
  /** What the page is drawn inside. */
  frame: Frame;
  /** A cursor, or a fingertip. */
  pointer: Pointer;
  /** How the tour looks. Defaults to {@link DEFAULT_LOOK}. */
  look?: Look;
  /** Frames per second, for CSS animations in the look, which are drawn a frame per tick. */
  fps?: number;
  /** Whether the browser or phone frame shows an address bar. Defaults to true. */
  addressBar?: boolean;
  /**
   * What the frame is centered on, when other parts of the same recording are bigger: the
   * recording's size, the panel aside. Defaults to the frame's own size.
   */
  canvas?: { width: number; height: number };
  /**
   * The steps' panel to draw into every frame, with every step's title in the recording, and
   * where this part's steps start among them.
   */
  panel?: (Panel & { titles: string[]; offset: number; drawn?: boolean }) | null;
  /** The CSS background around the frame, for every part of a recording alike; see `phone.backdrop`. */
  backdrop?: string;
  /** `png` (the default) for the encoders, or `jpeg` at `quality` for the HTML player. */
  type?: 'png' | 'jpeg';
  /** JPEG quality, 0–100. */
  quality?: number;
  /** Readies the drawing page as `record` readies its own (Chrome needs its window enlarged). */
  prepare?: (page: Page) => Promise<void>;
}

// Where everything sits: the whole picture, and the frame's top-left corner in it.
function layoutOf(options: {
  viewport: { width: number; height: number };
  frame: Frame;
  addressBar?: boolean;
  canvas?: { width: number; height: number };
  panel?: (Panel & { drawn?: boolean }) | null;
}): {
  size: { width: number; height: number };
  at: { x: number; y: number };
  framed: { width: number; height: number };
} {
  const framed = framedSize(options.frame, options.viewport, options.addressBar);
  const canvas = options.canvas ?? framed;
  const band = options.panel && options.panel.drawn !== false ? options.panel.height : 0;
  return {
    size: { width: canvas.width, height: canvas.height + band },
    at: {
      x: Math.round((canvas.width - framed.width) / 2),
      y:
        Math.round((canvas.height - framed.height) / 2) +
        (options.panel?.placement === 'above' ? band : 0),
    },
    framed,
  };
}

// The stage every beat is drawn on. Kept as source because lib/ is typechecked without the DOM.
function stageHTML(
  options: {
    viewport: { width: number; height: number };
    frame: Frame;
    pointer: Pointer;
    addressBar?: boolean;
    panel?: (Panel & { titles: string[]; drawn?: boolean }) | null;
  },
  layout: ReturnType<typeof layoutOf>,
): string {
  const { viewport, frame, pointer } = options;
  const panel = options.panel && options.panel.drawn !== false ? options.panel : null;
  const addressBar = options.addressBar ?? true;
  const { width, height } = viewport;
  const outer = layout.size;
  const phone = frame === 'phone';
  // Centered on a bigger canvas, the frame sits on the backdrop, as a phone always does.
  const letterboxed =
    layout.framed.width !== outer.width ||
    layout.framed.height !== outer.height - (panel ? panel.height : 0);
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
* { box-sizing: border-box; }
/* The hidden attribute hides HTML elements only; the arrow is an <svg>, so it is said here. */
[hidden] { display: none !important; }
html, body { margin: 0; width: ${outer.width}px; height: ${outer.height}px; overflow: hidden; background: ${phone || letterboxed ? 'var(--backdrop)' : '#fff'};
  font: 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif; color: #202124; }
#device { position: absolute; left: ${layout.at.x + (phone ? PHONE.margin : 0)}px; top: ${layout.at.y + (phone ? PHONE.margin : 0)}px;
  ${phone ? `padding: ${PHONE.bezel}px; border-radius: 44px; background: #15171c; box-shadow: 0 10px 30px rgba(0,0,0,.25);` : ''} }
#chrome { display: ${frame === 'browser' ? 'block' : 'none'}; height: ${addressBar ? CHROME_HEIGHT : TAB_STRIP_HEIGHT}px; background: var(--chrome); }
#tabs { display: flex; gap: 2px; height: ${TAB_STRIP_HEIGHT}px; padding: 6px 8px 0 72px; position: relative; }
#tabs::before { content: ""; position: absolute; left: 14px; top: 13px; width: 44px; height: 12px;
  background: radial-gradient(circle at 6px 6px, #ff5f57 5px, transparent 6px), radial-gradient(circle at 22px 6px, #febc2e 5px, transparent 6px), radial-gradient(circle at 38px 6px, #28c840 5px, transparent 6px); }
.tab { width: 200px; max-width: 30%; padding: 9px 12px; border-radius: 8px 8px 0 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--tab-text); }
.tab.active { background: var(--bar); color: var(--text); }
#bar { height: ${CHROME_HEIGHT - TAB_STRIP_HEIGHT}px; background: var(--bar); display: ${addressBar ? 'flex' : 'none'}; align-items: center; padding: 0 12px; border-bottom: 1px solid var(--rule); }
#url, #mobile-url { flex: 1; height: 26px; border-radius: 13px; background: var(--field); padding: 7px 14px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#mobile-bar { display: ${phone && addressBar ? 'flex' : 'none'}; height: ${PHONE.bar}px; align-items: center; gap: 8px; padding: 0 10px; background: #fff; border-radius: 32px 32px 0 0; }
#mobile-url { text-align: center; }
#tab-count { min-width: 22px; height: 22px; border: 2px solid #3c4043; border-radius: 6px; font-weight: 700; display: grid; place-items: center; }
#stage { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; ${phone ? `border-radius: ${addressBar ? '0 0 32px 32px' : '32px'};` : ''} }
#shot { position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px; transform-origin: 0 0; }
#cursor, #cursor-image { position: absolute; left: 0; top: 0; filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); z-index: 5; }
#cursor { color: #fff; stroke: #111; stroke-width: 1.6; stroke-linejoin: round; fill: currentColor; }
.finger { position: absolute; left: 0; top: 0; border-radius: 50%; border: 3px solid rgba(255,255,255,.95); background: rgba(32,33,36,.28);
  box-shadow: 0 2px 8px rgba(0,0,0,.35); z-index: 5; }
#ripple, .ripple { position: absolute; border-radius: 50%; border: 3px solid; color: rgba(66,133,244,.9); z-index: 4; }
#ripple::after, .ripple::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: currentColor; opacity: .25; }
.finger.labelled::after { content: attr(data-finger); position: absolute; inset: 0; display: grid; place-items: center;
  color: #fff; font-weight: 700; font-family: system-ui, sans-serif; text-shadow: 0 1px 2px rgba(0,0,0,.6); }
#menu { position: absolute; padding: 4px 0; background: #fff; border: 1px solid rgba(0,0,0,.14); border-radius: 8px; transform-origin: 0 0;
  box-shadow: 0 8px 24px rgba(0,0,0,.22); font: 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif; color: #202124; z-index: 3; }
#menu div { padding: 0 14px; display: flex; align-items: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#menu .highlighted { background: #1a73e8; color: #fff; }
#caption { position: absolute; left: 50%; transform: translateX(-50%); max-width: 86%; padding: .55em 1em; border-radius: 10px;
  background: rgba(17,20,28,.86); color: #fff; font: 600 18px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; text-align: center; z-index: 4; }
#caption.bottom { bottom: 24px; } #caption.top { top: 24px; }
#highlight { position: absolute; border-radius: 10px; outline: 3px solid #ffd43b; box-shadow: 0 0 0 100vmax rgba(10,12,18,.55); z-index: 2; }
#keys { position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%); display: flex; gap: 6px; z-index: 4; }
#caption.bottom:not([hidden]) ~ #keys { bottom: 84px; }
#keys kbd { min-width: 1.9em; padding: .4em .65em; border-radius: 8px; background: rgba(17,20,28,.86); color: #fff; text-align: center;
  font: 600 20px/1 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: inset 0 -3px 0 rgba(255,255,255,.18); }
#chapter { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .5em; padding: 8%;
  background: #11141c; color: #fff; text-align: center; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; z-index: 6; }
#chapter .title { font-size: clamp(22px, 6cqw, 60px); font-weight: 700; line-height: 1.15; }
#chapter .subtitle { font-size: clamp(14px, 2.6cqw, 26px); line-height: 1.4; opacity: .72; }
${PANEL_CSS}
#panel { position: absolute; left: 0; width: 100%; height: ${panel ? panel.height : 0}px; ${panel?.placement === 'above' ? 'top: 0' : 'bottom: 0'}; z-index: 7; }
</style><style id="user-css"></style><style>
/* Every frame is drawn from the tour's timeline: @keyframes run on its clock (see __tick), and
   transitions, which would start on the browser's own, stay off. */
*, *::before, *::after { transition: none !important; }
</style></head><body>
<div id="device">
  <div id="chrome"><div id="tabs"></div><div id="bar"><div id="url"></div></div></div>
  <div id="mobile-bar"><div id="mobile-url"></div><div id="tab-count"></div></div>
  <div id="stage">
    <img id="shot" alt="">
    <div id="ripple" hidden></div>
    <div id="menu" hidden></div>
    <svg id="cursor" viewBox="0 0 22 28" hidden><path id="arrow" d="M2 2 L2 22 L7.5 17 L11 25.5 L14.5 24 L11 15.5 L18.5 15.5 Z"/></svg>
    <img id="cursor-image" alt="" hidden>
    <div id="fingers"></div>
    <div id="caption" hidden></div>
    <div id="highlight" hidden></div>
    <div id="keys" hidden></div>
    <div id="chapter" hidden><div class="title"></div><div class="subtitle"></div></div>
  </div>
</div>
${panel ? panelHTML(false) : ''}
<script>
${PANEL_SCRIPT}
  const urls = [];
  const finger = ${pointer === 'finger'};
  let style = null;
  globalThis.__load = (index, base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    urls[index] = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  };
  const $ = (id) => document.getElementById(id);
  globalThis.__configure = async (configured) => {
    style = configured;
    const themes = {
      light: { chrome: '#dee1e6', bar: '#fff', field: '#f1f3f4', text: '#202124', 'tab-text': '#5f6368', rule: '#dadce0' },
      dark: { chrome: '#202124', bar: '#35363a', field: '#202124', text: '#e8eaed', 'tab-text': '#9aa0a6', rule: '#4a4c50' },
    };
    for (const [name, value] of Object.entries(themes[style.browser.theme])) document.documentElement.style.setProperty('--' + name, value);
    document.documentElement.style.setProperty('--backdrop', style.phone.backdrop);
    const userCss = $('user-css');
    // A stylesheet that @imports (a web font, say) is waited for, so the first frame has it.
    const imported = /@import/.test(style.css) && new Promise((done) => { userCss.onload = userCss.onerror = done; });
    userCss.textContent = style.css;
    await imported;
    if (style.panel) {
      globalThis.__panelSetup(style.panel.titles, false);
      dress($('panel'), style.panel.style);
    }
    dress($('caption'), style.caption.style);
    // A caption meant for a panel the recording does not have stays over the page.
    $('caption').className = style.caption.placement === 'panel' ? 'bottom' : style.caption.placement;
    dress($('menu'), style.menu.style);
    dress($('highlight'), style.highlight.style);
    if (style.keys) dress($('keys'), style.keys.style);
    dress($('chapter'), style.chapter.style);
    dress($('device'), ${phone} ? style.phone.style : {});
    dress($('chrome'), style.browser.style);
    if (style.ripple) dress($('ripple'), style.ripple.style);
    const cursor = style.cursor;
    if (cursor.image) {
      const image = $('cursor-image');
      image.src = cursor.image;
      dress(image, cursor.style);
      image.style.height = cursor.size + 'px';
      await image.decode().catch(() => {});
    } else {
      const svg = $('cursor');
      dress(svg, cursor.style);
      svg.style.height = cursor.size + 'px';
      svg.style.width = (cursor.size * 22) / 28 + 'px';
    }
  };
  // A part's own CSS, inline: over the stage's defaults and over the tour's css.
  const dress = (element, declarations) => {
    for (const [property, value] of Object.entries(declarations)) element.style.setProperty(property, value);
  };
  const fingertip = (index) => {
    const pool = $('fingers');
    while (pool.children.length <= index) {
      const tip = document.createElement('div');
      tip.className = style.finger.labels ? 'finger labelled' : 'finger';
      // Numbered as the gesture's fingers are, for a stylesheet to tell a thumb from the rest.
      tip.dataset.finger = String(pool.children.length + 1);
      dress(tip, style.finger.style);
      Object.assign(tip.style, { width: style.finger.size + 'px', height: style.finger.size + 'px', fontSize: Math.round(style.finger.size * 0.42) + 'px' });
      pool.append(tip);
    }
    return pool.children[index];
  };
  // When each part last appeared, or changed what it shows: its animations start from there.
  const mark = (element, shows, atMs) => {
    if (element.dataset.shows !== shows) {
      element.dataset.shows = shows;
      element.dataset.since = String(atMs);
    }
  };
  // Every animation seen: one past its end drops out of getAnimations(), and a new caption must
  // still be able to wind it back. Those the browser cancels (their part hidden) are let go.
  const animations = new Set();
  // Sets every animation to its place at atMs; true if any was still moving a tick (stepMs) before.
  globalThis.__tick = (atMs, stepMs) => {
    let moving = false;
    for (const animation of document.getAnimations()) animations.add(animation);
    for (const animation of animations) {
      if (animation.playState === 'idle' || !animation.effect.target.isConnected) {
        animations.delete(animation);
        continue;
      }
      const owner = animation.effect.target.closest('[data-since]');
      const local = atMs - (owner ? Number(owner.dataset.since) : 0);
      animation.pause();
      animation.currentTime = Math.max(0, local);
      if (local - stepMs < animation.effect.getComputedTiming().endTime) moving = true;
    }
    return moving;
  };
  globalThis.__show = async (beat, atMs) => {
    const scale = ${width} / beat.camera.width;
    const shot = $('shot');
    if (shot.dataset.index !== String(beat.shot)) {
      shot.src = urls[beat.shot];
      shot.dataset.index = String(beat.shot);
      await shot.decode().catch(() => {});
    }
    shot.style.transform = 'scale(' + scale + ') translate(' + -beat.camera.x + 'px,' + -beat.camera.y + 'px)';
    const onStage = (point) => ({ x: (point.x - beat.camera.x) * scale, y: (point.y - beat.camera.y) * scale });
    const menu = $('menu');
    menu.hidden = !beat.menu;
    if (beat.menu) {
      const at = onStage(beat.menu);
      // Laid out at page size and scaled with the camera, so whatever its style sets zooms with it.
      Object.assign(menu.style, { left: at.x + 'px', top: at.y + 'px', width: beat.menu.width + 'px', transform: 'scale(' + scale + ')' });
      menu.replaceChildren(...beat.menu.items.map((item, index) => {
        const row = document.createElement('div');
        row.textContent = item;
        row.style.height = beat.menu.itemHeight + 'px';
        if (index === beat.menu.highlighted) {
          row.className = 'highlighted';
          dress(row, style.menu.highlightStyle);
        }
        return row;
      }));
    }
    const arrow = $('cursor');
    const image = $('cursor-image');
    arrow.toggleAttribute('hidden', true);
    image.toggleAttribute('hidden', true);
    const touching = finger ? (beat.cursor ? [beat.cursor, ...beat.touches] : []) : [];
    Array.from($('fingers').children).forEach((tip) => (tip.hidden = true));
    if (finger) {
      touching.forEach((point, index) => {
        const tip = fingertip(index);
        const at = onStage(point);
        tip.hidden = false;
        tip.style.transform = 'translate(' + (at.x - style.finger.size / 2) + 'px,' + (at.y - style.finger.size / 2) + 'px)';
      });
    } else if (beat.cursor) {
      const pointer = style.cursor.image ? image : arrow;
      const hotspot = style.cursor.image ? style.cursor.hotspot : { x: (style.cursor.hotspot.x * style.cursor.size) / 28, y: (style.cursor.hotspot.y * style.cursor.size) / 28 };
      const at = onStage(beat.cursor);
      // toggleAttribute, not .hidden: an <svg> has no hidden property to set.
      pointer.toggleAttribute('hidden', false);
      pointer.style.transform = 'translate(' + (at.x - hotspot.x) + 'px,' + (at.y - hotspot.y) + 'px)';
    }
    // A ripple under every finger that touched: #ripple for the first, .ripple for the rest.
    const touched = beat.ripple === null || !beat.cursor || !style.ripple ? [] : finger ? [beat.cursor, ...beat.touches] : [beat.cursor];
    const ripples = [$('ripple'), ...document.querySelectorAll('.ripple')];
    while (ripples.length < touched.length) {
      const extra = document.createElement('div');
      extra.className = 'ripple';
      if (style.ripple) dress(extra, style.ripple.style);
      $('stage').append(extra);
      ripples.push(extra);
    }
    ripples.forEach((ripple, index) => {
      ripple.hidden = index >= touched.length;
      if (ripple.hidden) return;
      const at = onStage(touched[index]);
      const radius = (finger ? style.finger.size * 0.4 : 6) + beat.ripple * 26;
      Object.assign(ripple.style, { left: at.x - radius + 'px', top: at.y - radius + 'px', width: radius * 2 + 'px', height: radius * 2 + 'px', opacity: String(1 - beat.ripple * 0.8) });
    });
    const caption = $('caption');
    // In the panel, when there is one, rather than over the page.
    if (style.panel) {
      globalThis.__panel(style.panel.offset + beat.step, style.captionOutside ? beat.caption : '', '');
    }
    caption.hidden = !beat.caption || style.captionOutside;
    caption.textContent = beat.caption || '';
    const highlight = $('highlight');
    highlight.hidden = !beat.highlight;
    if (beat.highlight) {
      const { rect, strength } = beat.highlight;
      const at = onStage(rect);
      Object.assign(highlight.style, { left: at.x + 'px', top: at.y + 'px', width: rect.width * scale + 'px', height: rect.height * scale + 'px', opacity: String(strength) });
    }
    const keys = $('keys');
    keys.hidden = !beat.keys || !style.keys;
    keys.replaceChildren(...(beat.keys || []).map((label) => Object.assign(document.createElement('kbd'), { textContent: label })));
    const chapter = $('chapter');
    chapter.hidden = !beat.chapter;
    if (beat.chapter) {
      chapter.style.opacity = String(beat.chapter.strength);
      chapter.querySelector('.title').textContent = beat.chapter.title;
      chapter.querySelector('.subtitle').textContent = beat.chapter.subtitle || '';
      chapter.querySelector('.subtitle').hidden = !beat.chapter.subtitle;
    }
    $('tabs').replaceChildren(...beat.tabs.titles.map((title, index) => {
      const tab = document.createElement('div');
      tab.className = 'tab' + (index === beat.tabs.active ? ' active' : '');
      tab.textContent = title || 'Untitled';
      return tab;
    }));
    $('url').textContent = beat.tabs.url;
    $('mobile-url').textContent = beat.tabs.url.replace(/^https?:\\/\\//, '');
    $('tab-count').textContent = String(beat.tabs.titles.length);
    mark(caption, beat.caption || '', atMs);
    mark(highlight, beat.highlight ? 'on' : '', atMs);
    mark(keys, (beat.keys || []).join('+'), atMs);
    mark(chapter, beat.chapter ? beat.chapter.title + '\\n' + (beat.chapter.subtitle || '') : '', atMs);
    mark(menu, beat.menu ? beat.menu.items.join('\\n') : '', atMs);
    mark($('device'), 'on', 0);
    globalThis.__tick(atMs, 0);
    await document.fonts.ready;
    await new Promise((painted) => requestAnimationFrame(() => requestAnimationFrame(painted)));
  };
</script>
</body></html>`;
}
