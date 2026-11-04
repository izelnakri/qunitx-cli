import { progress } from '../progress.ts';
import * as DeviceFrame from './device-frame.ts';
import type { Browser, Page } from 'playwright-core';
import type { Frame } from '../capture.ts';
import type { Beat } from './timeline.ts';
import type { Look } from './look.ts';

// The stage: an ordinary page of the same browser that draws a tour's frames once it has run. Each
// beat lays a screenshot under the camera, then the pointer, a ripple, the caption and the rest of
// the overlays, inside the device frame, and is screenshot as the frame a GIF or video is made of.

/**
 * How the pointer is drawn: a mouse cursor, always on screen, or a fingertip, only while it touches.
 *
 * ```ts
 * import type { Pointer } from './stage.ts';
 *
 * const pointer: Pointer = 'finger';
 * ```
 */
export type Pointer = 'cursor' | 'finger';

/**
 * What a tour run leaves for the stage to draw: the page's screenshots, and the beats that say what
 * each frame shows of them (which screenshot, under which camera) and for how long.
 *
 * ```ts
 * import type { Recording } from './stage.ts';
 *
 * const empty: Recording = { screenshots: [], beats: [] };
 * ```
 */
export interface Recording {
  /** PNG screenshots of the page, at the tour's `maxZoom` scale; beats refer to them by index. */
  screenshots: Uint8Array[];
  /** Each beat of the timeline, in order, with how long it stays on screen. */
  beats: Beat[];
}

/**
 * How the stage draws: the page's size and scale, what it sits inside, and how the tour looks.
 *
 * ```ts
 * import * as Look from './look.ts';
 * import type { Options } from './stage.ts';
 *
 * const options: Options = {
 *   viewport: { width: 390, height: 844 },
 *   scale: 1,
 *   deviceFrame: 'phone',
 *   addressBar: true,
 *   pointer: 'finger',
 *   look: Look.DEFAULT,
 *   fps: 10,
 *   preparePage: async () => {},
 * };
 * ```
 */
export interface Options {
  /** The recorded page's size, in CSS pixels. */
  viewport: { width: number; height: number };
  /** Device pixels per CSS pixel of the drawn frames. */
  scale: number;
  /** What the page is drawn inside. */
  deviceFrame: DeviceFrame.Kind;
  /** Whether the browser window or the phone shows its address bar. */
  addressBar: boolean;
  /** A mouse cursor, or a fingertip on a touch tour. */
  pointer: Pointer;
  /** How the tour looks, its CSS already checked by `Look.validateCSS`. */
  look: Look;
  /** Frames per second, at which a CSS animation of the look is drawn. */
  fps: number;
  /** Readies the stage's page as `record` readies its own (Chrome needs its window enlarged). */
  preparePage: (page: Page) => Promise<void>;
}

/**
 * An open stage: a page that draws beats one at a time, in the order they are shown, keeping the
 * tour's clock as it goes. Drawn with HTML and CSS because that is what renders text, curves and
 * shadows well, and the frames then look like the browser they came from.
 *
 * ```ts
 * import * as Stage from './stage.ts';
 * import type { Beat } from './timeline.ts';
 *
 * // Defined, not invoked: needs an open stage.
 * async function drawOne(stage: Stage.Stage, beat: Beat, screenshots: Uint8Array[]) {
 *   return await stage.draw(beat, screenshots); // the frames this beat shows
 * }
 * ```
 */
export interface Stage {
  /**
   * The frames `beat` shows, each with how long it stays on screen: one, unless a CSS animation of
   * the look is still moving; then one per tick of `fps` until it stops, each at its exact time on
   * the tour's clock. `screenshots` are the run's so far; any the stage hasn't seen are loaded.
   */
  draw(beat: Beat, screenshots: readonly Uint8Array[]): Promise<Frame[]>;
  /** Closes the stage's page. */
  close(): Promise<void>;
}

/**
 * Opens a stage in a context of its own in `browser`, so nothing it does reaches the pages being
 * recorded.
 *
 * ```ts
 * import * as Stage from './stage.ts';
 * import type { Browser } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live browser.
 * async function drawAll(browser: Browser, recording: Stage.Recording, options: Stage.Options) {
 *   const stage = await Stage.open(browser, options);
 *   try {
 *     return (await Array.fromAsync(recording.beats, (beat) => stage.draw(beat, recording.screenshots))).flat();
 *   } finally {
 *     await stage.close();
 *   }
 * }
 * ```
 */
export async function open(browser: Browser, options: Options): Promise<Stage> {
  const context = await browser.newContext({
    viewport: DeviceFrame.size(options.deviceFrame, options.viewport, options.addressBar),
    deviceScaleFactor: options.scale,
  });
  try {
    const page = await context.newPage();
    await options.preparePage(page);
    await page.setContent(
      html(options.viewport, options.deviceFrame, options.pointer, options.addressBar),
    );
    await page.evaluate(`globalThis.__configure(${JSON.stringify(options.look)})`);
    const step = 1000 / options.fps;
    let loaded = 0;
    let atMs = 0;
    return {
      async draw(beat, screenshots) {
        for (; loaded < screenshots.length; loaded++) {
          const base64 = Buffer.from(screenshots[loaded]).toString('base64');
          await page.evaluate(`globalThis.__load(${loaded}, ${JSON.stringify(base64)})`);
        }
        await page.evaluate(`globalThis.__show(${JSON.stringify(beat)}, ${atMs})`);
        const frames: Frame[] = [];
        let shownMs = 0;
        for (;;) {
          const png = await page.screenshot({ type: 'png' });
          const moving =
            shownMs + step < beat.durationMs &&
            (await page.evaluate<boolean>(`globalThis.__tick(${atMs + shownMs + step}, ${step})`));
          if (!moving) {
            frames.push({ png, durationMs: beat.durationMs - shownMs });
            break;
          }
          frames.push({ png, durationMs: step });
          shownMs += step;
        }
        atMs += beat.durationMs;
        return frames;
      },
      close: () => context.close().catch(() => {}),
    };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

/**
 * Draws every beat of a recording, once the tour has run, as the frames a GIF or video is encoded
 * from. Nothing here races the page being recorded: every beat is drawn exactly as described,
 * however long it takes. Advances `progress` by one per beat.
 *
 * ```ts
 * import * as Stage from './stage.ts';
 * import type { Browser } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live browser.
 * async function draw(browser: Browser, recording: Stage.Recording, options: Stage.Options) {
 *   return await Stage.drawFrames(browser, recording, options);
 * }
 * ```
 */
export async function drawFrames(
  browser: Browser,
  recording: Recording,
  options: Options,
): Promise<Frame[]> {
  const stage = await open(browser, options);
  try {
    const frames: Frame[] = [];
    // How far along the drawing is, for the phase the caller entered.
    progress.total = recording.beats.length;
    for (const beat of recording.beats) {
      frames.push(...(await stage.draw(beat, recording.screenshots)));
      progress.done += 1;
    }
    return frames;
  } finally {
    await stage.close();
  }
}

// The page every beat is drawn on. Kept as source because lib/ is typechecked without the DOM.
function html(
  viewport: { width: number; height: number },
  frame: DeviceFrame.Kind,
  pointer: Pointer,
  addressBar: boolean,
): string {
  const { width, height } = viewport;
  const outer = DeviceFrame.size(frame, viewport, addressBar);
  const phone = frame === 'phone';
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
* { box-sizing: border-box; }
/* The hidden attribute hides HTML elements only; the arrow is an <svg>, so it is said here. */
[hidden] { display: none !important; }
html, body { margin: 0; width: ${outer.width}px; height: ${outer.height}px; overflow: hidden; background: ${phone ? 'var(--backdrop)' : '#fff'};
  font: 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif; color: #202124; }
#device { position: absolute; left: ${phone ? DeviceFrame.PHONE.margin : 0}px; top: ${phone ? DeviceFrame.PHONE.margin : 0}px;
  ${phone ? `padding: ${DeviceFrame.PHONE.bezel}px; border-radius: 44px; background: #15171c; box-shadow: 0 10px 30px rgba(0,0,0,.25);` : ''} }
#chrome { display: ${frame === 'browser' ? 'block' : 'none'}; height: ${addressBar ? DeviceFrame.BROWSER_HEIGHT : DeviceFrame.TAB_STRIP_HEIGHT}px; background: var(--chrome); }
#tabs { display: flex; gap: 2px; height: ${DeviceFrame.TAB_STRIP_HEIGHT}px; padding: 6px 8px 0 72px; position: relative; }
#tabs::before { content: ""; position: absolute; left: 14px; top: 13px; width: 44px; height: 12px;
  background: radial-gradient(circle at 6px 6px, #ff5f57 5px, transparent 6px), radial-gradient(circle at 22px 6px, #febc2e 5px, transparent 6px), radial-gradient(circle at 38px 6px, #28c840 5px, transparent 6px); }
.tab { width: 200px; max-width: 30%; padding: 9px 12px; border-radius: 8px 8px 0 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--tab-text); }
.tab.active { background: var(--bar); color: var(--text); }
#bar { height: ${DeviceFrame.BROWSER_HEIGHT - DeviceFrame.TAB_STRIP_HEIGHT}px; background: var(--bar); display: ${addressBar ? 'flex' : 'none'}; align-items: center; padding: 0 12px; border-bottom: 1px solid var(--rule); }
#url, #mobile-url { flex: 1; height: 26px; border-radius: 13px; background: var(--field); padding: 7px 14px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#mobile-bar { display: ${phone && addressBar ? 'flex' : 'none'}; height: ${DeviceFrame.PHONE.bar}px; align-items: center; gap: 8px; padding: 0 10px; background: #fff; border-radius: 32px 32px 0 0; }
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
<script>
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
    dress($('caption'), style.caption.style);
    $('caption').className = style.caption.placement;
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
    caption.hidden = !beat.caption;
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
