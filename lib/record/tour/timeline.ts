/**
 * A point on the page, in CSS pixels from its top-left corner.
 *
 * ```ts
 * const point: Point = { x: 120, y: 48 };
 * ```
 */
export interface Point {
  /** From the left edge. */
  x: number;
  /** From the top edge. */
  y: number;
}

/**
 * A rectangle on the page, in CSS pixels: what the camera shows, or where an element is.
 *
 * ```ts
 * const rect: Rect = { x: 0, y: 0, width: 1280, height: 720 };
 * ```
 */
export interface Rect {
  /** Left edge. */
  x: number;
  /** Top edge. */
  y: number;
  /** Width. */
  width: number;
  /** Height. */
  height: number;
}

/**
 * The browser's tabs at one moment, for the tab strip.
 *
 * ```ts
 * const tabs: TabStrip = { titles: ['Home', 'Checkout'], active: 1, url: 'http://localhost:4200/checkout' };
 * ```
 */
export interface TabStrip {
  /** Each open tab's title, in order. */
  titles: string[];
  /** The index of the tab on screen. */
  active: number;
  /** The address bar: the active tab's URL. */
  url: string;
}

/**
 * A context menu drawn over the frame: where it sits, its items, and the one highlighted. Laid out
 * by {@link menuLayout}, so the compositor draws it and the tour clicks it at the same place.
 *
 * ```ts
 * const menu: Menu = { x: 104, y: 104, width: 200, itemHeight: 30, items: ['Copy', 'Paste'], highlighted: 1 };
 * ```
 */
export interface Menu {
  /** Left edge, in CSS pixels of the page. */
  x: number;
  /** Top edge. */
  y: number;
  /** Width. */
  width: number;
  /** Height of one item. */
  itemHeight: number;
  /** The items, top to bottom. */
  items: string[];
  /** The index of the item under the pointer, or null. */
  highlighted: number | null;
}

// A drawn menu: items this tall, inside this much padding, this wide.
const MENU = { width: 200, itemHeight: 30, padding: 4 } as const;

/**
 * Where a context menu opened at `at` sits: just below and right of the pointer, flipped to the
 * other side wherever it would run off the page, as real menus do.
 *
 * ```ts
 * import { menuLayout } from './timeline.ts';
 *
 * const viewport = { width: 800, height: 600 };
 * menuLayout({ x: 100, y: 100 }, ['Copy', 'Paste'], viewport).x; // 104
 * menuLayout({ x: 790, y: 590 }, ['Copy', 'Paste'], viewport).x; // 586 — opened leftwards
 * ```
 */
export function menuLayout(
  at: Point,
  items: string[],
  viewport: { width: number; height: number },
  width: number = MENU.width,
): Menu {
  const height = items.length * MENU.itemHeight + 2 * MENU.padding;
  const right = at.x + 4 + width <= viewport.width;
  const below = at.y + 4 + height <= viewport.height;
  return {
    x: Math.max(0, right ? at.x + 4 : at.x - 4 - width),
    y: Math.max(0, below ? at.y + 4 : at.y - 4 - height),
    width,
    itemHeight: MENU.itemHeight,
    items,
    highlighted: null,
  };
}

/**
 * The middle of a menu's item, where a pointer clicks to choose it.
 *
 * ```ts
 * import { menuItemPoint } from './timeline.ts';
 *
 * const menu = { x: 100, y: 100, width: 200, itemHeight: 30, items: ['Copy', 'Paste'], highlighted: null };
 * menuItemPoint(menu, 1); // { x: 160, y: 149 }
 * ```
 */
export function menuItemPoint(menu: Menu, index: number): Point {
  return {
    x: menu.x + 60,
    y: menu.y + MENU.padding + menu.itemHeight * index + menu.itemHeight / 2,
  };
}

/**
 * One frame of a tour, described rather than drawn: which screenshot is under it, where the cursor
 * and the camera are, and for how long it shows. The compositor turns each into pixels.
 *
 * ```ts
 * const beat: Beat = {
 *   shot: 0,
 *   cursor: { x: 10, y: 10 },
 *   touches: [],
 *   menu: null,
 *   ripple: null,
 *   camera: { x: 0, y: 0, width: 1280, height: 720 },
 *   caption: null,
 *   highlight: null,
 *   keys: null,
 *   chapter: null,
 *   tabs: { titles: ['Home'], active: 0, url: 'http://localhost/' },
 *   durationMs: 100,
 * };
 * ```
 */
export interface Beat {
  /** Index of the screenshot shown. */
  shot: number;
  /** Where the cursor, or the first finger, is; null hides it. */
  cursor: Point | null;
  /** Any other fingers touching, for a gesture of more than one. */
  touches: Point[];
  /** A context menu drawn over the page, or null. */
  menu: Menu | null;
  /** How far a click's ripple has spread, 0 to 1, or null for no ripple. */
  ripple: number | null;
  /** The part of the page on screen. The whole viewport when not zoomed. */
  camera: Rect;
  /** The caption over the bottom of the frame, or null for none. */
  caption: string | null;
  /** A region of the page lit up, the rest dimmed, and how far it has faded in (0 to 1); or null. */
  highlight: { rect: Rect; strength: number } | null;
  /** The keys of a keystroke being pressed, one badge each (`['Ctrl', 'K']`), or null. */
  keys: string[] | null;
  /** A title card over the whole frame, and how far it has faded in (0 to 1); or null. */
  chapter: { title: string; subtitle: string | null; strength: number } | null;
  /** The tabs, for the tab strip. */
  tabs: TabStrip;
  /** How long this frame shows, in ms. */
  durationMs: number;
}

/**
 * How many frames a movement of `durationMs` gets at `fps`: at least one.
 *
 * ```ts
 * import { frameCount } from './timeline.ts';
 *
 * frameCount(400, 10); // 4
 * frameCount(10, 10); // 1
 * ```
 */
export function frameCount(durationMs: number, fps: number): number {
  return Math.max(1, Math.round((durationMs * fps) / 1000));
}

/**
 * Ease in and out: slow to start, fast through the middle, slow to stop, the way a hand moves.
 *
 * ```ts
 * import { ease } from './timeline.ts';
 *
 * [ease(0), ease(0.5), ease(1)]; // [0, 0.5, 1]
 * ```
 */
export function ease(progress: number): number {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

/**
 * The camera that shows `target` filling `1 / scale` of the viewport, centered on it but never past
 * the page's edges, so a zoom near a corner moves the camera instead of showing empty space.
 *
 * ```ts
 * import { zoomedCamera } from './timeline.ts';
 *
 * const viewport = { width: 1000, height: 500 };
 * zoomedCamera({ x: 450, y: 225, width: 100, height: 50 }, 2, viewport);
 * // { x: 250, y: 125, width: 500, height: 250 }
 * zoomedCamera({ x: 0, y: 0, width: 10, height: 10 }, 2, viewport).x; // 0 — kept on the page
 * ```
 */
export function zoomedCamera(
  target: Rect,
  scale: number,
  viewport: { width: number; height: number },
): Rect {
  const width = viewport.width / scale;
  const height = viewport.height / scale;
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  return {
    x: clamp(target.x + target.width / 2 - width / 2, viewport.width - width),
    y: clamp(target.y + target.height / 2 - height / 2, viewport.height - height),
    width,
    height,
  };
}

/**
 * The tour as it is being recorded: each step appends the beats it shows, starting from where the
 * last one left off. Pure — the driver feeds it screenshots and positions, the compositor reads it.
 *
 * ```ts
 * import { Timeline } from './timeline.ts';
 *
 * const tabs = { titles: ['Home'], active: 0, url: 'http://localhost/' };
 * const timeline = new Timeline({ width: 800, height: 600 }, 10, tabs);
 * timeline.move({ x: 100, y: 100 }, 400);
 * timeline.beats.length; // 4 — one per frame at 10 fps
 * timeline.beats.at(-1)?.cursor; // { x: 100, y: 100 }
 * ```
 */
export class Timeline {
  /** Every beat so far, in order. */
  readonly beats: Beat[] = [];
  readonly #fps: number;
  readonly #viewport: { width: number; height: number };
  #state: Omit<Beat, 'durationMs' | 'ripple'>;

  /**
   * A timeline for a page of `viewport`'s size, drawn at `fps`, starting with `tabs` open. A
   * cursor is always on screen; a finger only while it touches, so a touch tour starts without one.
   */
  constructor(
    viewport: { width: number; height: number },
    fps: number,
    tabs: TabStrip,
    pointer: 'cursor' | 'finger' = 'cursor',
  ) {
    this.#viewport = viewport;
    this.#fps = fps;
    this.#state = {
      shot: 0,
      // The cursor enters from a little inside the top-left corner, as if from off screen.
      cursor: pointer === 'finger' ? null : { x: viewport.width * 0.08, y: viewport.height * 0.12 },
      touches: [],
      menu: null,
      camera: { x: 0, y: 0, width: viewport.width, height: viewport.height },
      caption: null,
      highlight: null,
      keys: null,
      chapter: null,
      tabs,
    };
  }

  /**
   * Where the cursor is now.
   *
   * ```ts
   * import { Timeline } from './timeline.ts';
   *
   * const timeline = new Timeline({ width: 800, height: 600 }, 10, { titles: [''], active: 0, url: '' });
   * timeline.cursor; // { x: 64, y: 72 } — just inside the top-left corner, to begin with
   * ```
   */
  get cursor(): Point | null {
    return this.#state.cursor;
  }

  /**
   * The whole page, unzoomed.
   *
   * ```ts
   * import { Timeline } from './timeline.ts';
   *
   * const timeline = new Timeline({ width: 800, height: 600 }, 10, { titles: [''], active: 0, url: '' });
   * timeline.viewport; // { x: 0, y: 0, width: 800, height: 600 }
   * ```
   */
  get viewport(): Rect {
    return { x: 0, y: 0, ...this.#viewport };
  }

  /**
   * Shows `shot` from here on, under everything else as it is.
   *
   * ```ts
   * import { Timeline } from './timeline.ts';
   *
   * const timeline = new Timeline({ width: 800, height: 600 }, 10, { titles: [''], active: 0, url: '' });
   * timeline.show(2);
   * timeline.hold(100);
   * timeline.beats[0].shot; // 2
   * ```
   */
  show(shot: number, tabs?: TabStrip): void {
    this.#state = { ...this.#state, shot, ...(tabs ? { tabs } : {}) };
  }

  /**
   * Sets the caption from here on; null removes it.
   *
   * ```ts
   * import { Timeline } from './timeline.ts';
   *
   * const timeline = new Timeline({ width: 800, height: 600 }, 10, { titles: [''], active: 0, url: '' });
   * timeline.caption('Hello');
   * timeline.hold(100);
   * timeline.beats[0].caption; // 'Hello'
   * ```
   */
  caption(text: string | null): void {
    this.#state = { ...this.#state, caption: text };
  }

  /**
   * Lights up `rect` and dims the rest, fading in over `durationMs`; null fades it back out.
   *
   * ```ts
   * import { Timeline } from './timeline.ts';
   *
   * const timeline = new Timeline({ width: 800, height: 600 }, 10, { titles: [''], active: 0, url: '' });
   * timeline.highlight({ x: 10, y: 10, width: 100, height: 40 }, 300);
   * timeline.beats.at(-1)!.highlight!.strength; // 1
   * ```
   */
  highlight(rect: Rect | null, durationMs: number): void {
    const shown = this.#state.highlight;
    if (rect) {
      // From a region already lit, it moves there; from nothing, it fades in where it is.
      const from = shown ? shown.rect : rect;
      const mix = (a: number, b: number, progress: number) => a + (b - a) * progress;
      const start = shown?.strength ?? 0;
      this.#animate(durationMs, (progress) => ({
        highlight: {
          rect: {
            x: mix(from.x, rect.x, progress),
            y: mix(from.y, rect.y, progress),
            width: mix(from.width, rect.width, progress),
            height: mix(from.height, rect.height, progress),
          },
          strength: mix(start, 1, progress),
        },
      }));
    } else if (shown) {
      this.#animate(durationMs, (progress) => ({
        highlight: { rect: shown.rect, strength: 1 - progress },
      }));
      this.#state = { ...this.#state, highlight: null };
    }
  }

  /**
   * Puts a shown highlight on `rect` at once, as the page scrolls its target along under it.
   *
   * ```ts
   * import { Timeline } from './timeline.ts';
   *
   * const timeline = new Timeline({ width: 800, height: 600 }, 10, { titles: [''], active: 0, url: '' });
   * timeline.highlight({ x: 10, y: 300, width: 100, height: 40 }, 300);
   * timeline.highlightAt({ x: 10, y: 200, width: 100, height: 40 });
   * timeline.hold(100);
   * timeline.beats.at(-1)!.highlight!.rect.y; // 200
   * ```
   */
  highlightAt(rect: Rect): void {
    const shown = this.#state.highlight;
    if (shown) this.#state = { ...this.#state, highlight: { ...shown, rect } };
  }

  /**
   * Shows the badges of a keystroke from here on; null removes them.
   *
   * ```ts
   * import { Timeline } from './timeline.ts';
   *
   * const timeline = new Timeline({ width: 800, height: 600 }, 10, { titles: [''], active: 0, url: '' });
   * timeline.keys(['Ctrl', 'K']);
   * timeline.hold(700);
   * timeline.beats.at(-1)!.keys; // ['Ctrl', 'K']
   * ```
   */
  keys(keys: string[] | null): void {
    this.#state = { ...this.#state, keys };
  }

  /**
   * A title card over the whole frame: it fades in over `fadeMs`, holds, and fades out over
   * `fadeMs`, `durationMs` in all.
   *
   * ```ts
   * import { Timeline } from './timeline.ts';
   *
   * const timeline = new Timeline({ width: 800, height: 600 }, 10, { titles: [''], active: 0, url: '' });
   * timeline.chapter('Checkout', null, 2000, 300);
   * timeline.beats.map((beat) => beat.chapter?.strength ?? 0).includes(1); // true
   * ```
   */
  chapter(title: string, subtitle: string | null, durationMs: number, fadeMs: number): void {
    const fade = Math.min(fadeMs, durationMs / 2);
    const card = (strength: number) => ({ chapter: { title, subtitle, strength } });
    this.#animate(fade, card);
    this.hold(durationMs - 2 * fade);
    this.#animate(fade, (progress) => card(1 - progress));
    this.#state = { ...this.#state, chapter: null };
  }

  /**
   * Puts the pointer at `point` from here on, without moving there: a finger touching down. Null
   * lifts it.
   *
   * ```ts
   * import { Timeline } from './timeline.ts';
   *
   * const timeline = new Timeline({ width: 800, height: 600 }, 10, { titles: [''], active: 0, url: '' }, 'finger');
   * timeline.cursor; // null — no finger until it touches
   * timeline.pointerAt({ x: 100, y: 200 });
   * timeline.cursor; // { x: 100, y: 200 }
   * ```
   */
  pointerAt(point: Point | null): void {
    this.#state = { ...this.#state, cursor: point };
  }

  /**
   * Puts more fingers down beside the first, for a gesture of two or more; an empty list lifts them.
   *
   * ```ts
   * import { Timeline } from './timeline.ts';
   *
   * const timeline = new Timeline({ width: 800, height: 600 }, 10, { titles: [''], active: 0, url: '' }, 'finger');
   * timeline.touchesAt([{ x: 300, y: 300 }]);
   * timeline.hold(100);
   * timeline.beats[0].touches; // [{ x: 300, y: 300 }]
   * ```
   */
  touchesAt(points: Point[]): void {
    this.#state = { ...this.#state, touches: points };
  }

  /**
   * Draws a context menu over the page from here on; null closes it.
   *
   * ```ts
   * import { Timeline, menuLayout } from './timeline.ts';
   *
   * const viewport = { width: 800, height: 600 };
   * const timeline = new Timeline(viewport, 10, { titles: [''], active: 0, url: '' });
   * timeline.menu(menuLayout({ x: 100, y: 100 }, ['Copy'], viewport));
   * timeline.hold(100);
   * timeline.beats[0].menu?.items; // ['Copy']
   * ```
   */
  menu(menu: Menu | null): void {
    this.#state = { ...this.#state, menu };
  }

  /**
   * Holds the frame as it is for `durationMs`.
   *
   * ```ts
   * import { Timeline } from './timeline.ts';
   *
   * const timeline = new Timeline({ width: 800, height: 600 }, 10, { titles: [''], active: 0, url: '' });
   * timeline.hold(300);
   * timeline.beats[0].durationMs; // 300
   * ```
   */
  hold(durationMs: number): void {
    if (durationMs > 0) this.#push({ ...this.#state, ripple: null, durationMs });
  }

  /**
   * Moves the cursor to `to`, easing, over `durationMs`.
   *
   * ```ts
   * import { Timeline } from './timeline.ts';
   *
   * const timeline = new Timeline({ width: 800, height: 600 }, 10, { titles: [''], active: 0, url: '' });
   * timeline.move({ x: 400, y: 300 }, 300);
   * timeline.cursor; // { x: 400, y: 300 }
   * ```
   */
  move(to: Point, durationMs: number): void {
    const from = this.#state.cursor ?? to;
    this.#animate(durationMs, (progress) => ({
      cursor: { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress },
    }));
  }

  /**
   * Pans and zooms the camera to `to`, easing, over `durationMs`.
   *
   * ```ts
   * import { Timeline } from './timeline.ts';
   *
   * const timeline = new Timeline({ width: 800, height: 600 }, 10, { titles: [''], active: 0, url: '' });
   * timeline.camera({ x: 0, y: 0, width: 400, height: 300 }, 300);
   * timeline.beats.at(-1)?.camera.width; // 400
   * ```
   */
  camera(to: Rect, durationMs: number): void {
    const from = this.#state.camera;
    const mix = (a: number, b: number, progress: number) => a + (b - a) * progress;
    this.#animate(durationMs, (progress) => ({
      camera: {
        x: mix(from.x, to.x, progress),
        y: mix(from.y, to.y, progress),
        width: mix(from.width, to.width, progress),
        height: mix(from.height, to.height, progress),
      },
    }));
  }

  /**
   * A click's ripple spreading from the cursor over `durationMs`.
   *
   * ```ts
   * import { Timeline } from './timeline.ts';
   *
   * const timeline = new Timeline({ width: 800, height: 600 }, 10, { titles: [''], active: 0, url: '' });
   * timeline.ripple(200);
   * timeline.beats.map((beat) => beat.ripple); // [0.5, 1]
   * ```
   */
  ripple(durationMs: number): void {
    const count = frameCount(durationMs, this.#fps);
    for (let index = 1; index <= count; index++) {
      this.#push({ ...this.#state, ripple: index / count, durationMs: durationMs / count });
    }
  }

  // One beat per frame, each a step further along the eased curve; the last lands exactly on it.
  #animate(durationMs: number, at: (progress: number) => Partial<Beat>): void {
    const count = frameCount(durationMs, this.#fps);
    for (let index = 1; index <= count; index++) {
      this.#state = { ...this.#state, ...at(ease(index / count)) };
      this.#push({ ...this.#state, ripple: null, durationMs: durationMs / count });
    }
  }

  // A beat that looks exactly like the one before it only makes that one last longer.
  #push(beat: Beat): void {
    const last = this.beats.at(-1);
    if (last && sameFrame(last, beat)) last.durationMs += beat.durationMs;
    else this.beats.push(beat);
  }
}

function sameFrame(a: Beat, b: Beat): boolean {
  return JSON.stringify({ ...a, durationMs: 0 }) === JSON.stringify({ ...b, durationMs: 0 });
}

// How a key is written on a badge, where Playwright's name for it isn't what a keyboard shows.
const KEY_LABELS: Record<string, string> = {
  Control: 'Ctrl',
  ControlOrMeta: 'Ctrl',
  Meta: '⌘',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backspace: '⌫',
  Delete: 'Del',
  Enter: 'Enter ↵',
  ' ': 'Space',
};

/**
 * The badges a keystroke is drawn as: one per key of a Playwright key or combination.
 *
 * ```ts
 * import { keyLabels } from './timeline.ts';
 *
 * keyLabels('Control+K'); // ['Ctrl', 'K']
 * keyLabels('Meta+Shift+ArrowUp'); // ['⌘', 'Shift', '↑']
 * keyLabels('Control++'); // ['Ctrl', '+']
 * ```
 */
export function keyLabels(key: string): string[] {
  // `+` joins keys, and is also a key: `Control++` is Control and plus.
  const keys =
    key.length > 1 && key.endsWith('++')
      ? [...key.slice(0, -2).split('+'), '+']
      : key === '+'
        ? ['+']
        : key.split('+');
  return keys.map((name) => KEY_LABELS[name] ?? (name.length === 1 ? name.toUpperCase() : name));
}

/**
 * Where `count` fingertips sit, as a hand holds them: in a row across `angle` (the direction the
 * hand moves, in radians; 0 is rightwards), `spacing` apart and centered on `center`, the middle
 * ones a little ahead of the outer ones, as fingers are.
 *
 * ```ts
 * import { handLayout } from './timeline.ts';
 *
 * handLayout({ x: 100, y: 100 }, 1, 50, 0); // [{ x: 100, y: 100 }]
 * handLayout({ x: 100, y: 100 }, 2, 50, Math.PI / 2).map((point) => Math.round(point.x)); // [125, 75]
 * ```
 */
export function handLayout(center: Point, count: number, spacing: number, angle: number): Point[] {
  // Across the motion, and along it (the arch).
  const across = { x: -Math.sin(angle), y: Math.cos(angle) };
  const along = { x: Math.cos(angle), y: Math.sin(angle) };
  const middle = (count - 1) / 2;
  return Array.from({ length: count }, (_, index) => {
    const offset = (index - middle) * spacing;
    const ahead = middle ? (1 - ((index - middle) / middle) ** 2) * spacing * 0.3 : 0;
    return {
      x: center.x + across.x * offset + along.x * ahead,
      y: center.y + across.y * offset + along.y * ahead,
    };
  });
}

/**
 * Where `count` fingertips sit for a pinch: evenly round a circle of `radius` about `center`,
 * turned by `angle` radians. Two fingers are side by side, left and right.
 *
 * ```ts
 * import { pinchLayout } from './timeline.ts';
 *
 * pinchLayout({ x: 100, y: 100 }, 2, 20, 0).map((point) => Math.round(point.x)); // [80, 120]
 * pinchLayout({ x: 0, y: 0 }, 4, 10, 0).length; // 4
 * ```
 */
export function pinchLayout(center: Point, count: number, radius: number, angle: number): Point[] {
  return Array.from({ length: count }, (_, index) => {
    const turn = angle + Math.PI + (index * 2 * Math.PI) / count;
    return { x: center.x + Math.cos(turn) * radius, y: center.y + Math.sin(turn) * radius };
  });
}
