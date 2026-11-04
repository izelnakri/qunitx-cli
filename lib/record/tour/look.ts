import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Page } from 'playwright-core';
import type { TourOptions } from './index.ts';

// How a tour looks: its options (sizes, placements, a cursor image) and the CSS laid over each part
// of the stage it is drawn on. Resolved from the tour's options, then checked by the browser itself.

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
 * import * as Look from './look.ts';
 *
 * const look: Look.Look = { ...Look.DEFAULT, caption: { placement: 'top', style: { borderRadius: 0 } } };
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
    placement: 'top' | 'bottom';
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
 * import * as Look from './look.ts';
 *
 * Look.DEFAULT.finger.size; // 44 — about a real fingertip on a phone
 * Look.DEFAULT.caption.placement; // 'bottom'
 * ```
 */
export const DEFAULT: Look = {
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
 * How a tour looks: its options laid over the defaults, sizes and choices checked, and a cursor
 * image's path made a `file:` URL (relative to `directory`, the tour file's own), for
 * {@link embedCursorImage} to read. Whether the browser takes each CSS declaration is for {@link validateCSS}.
 *
 * ```ts
 * import * as Look from './look.ts';
 *
 * Look.fromOptions({ cursor: { size: 40, style: { color: '#e03131' } } }, '/proj').cursor.size; // 40
 * Look.fromOptions({ ripple: false }, '/proj').ripple; // null
 * Look.fromOptions({ caption: { placement: 'top' } }, '/proj').caption.style; // {} — the stage's own CSS
 * ```
 */
export function fromOptions(options: TourOptions, directory: string): Look {
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
        `${name} must be ${choices.map((choice) => `'${choice}'`).join(' or ')}, not '${value}'`,
      );
    return value;
  };
  // Whether the browser takes each declaration is checked by validateCSS, once it is up.
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
  const fallback = DEFAULT;
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
        ['bottom', 'top'],
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
 * import * as Look from './look.ts';
 *
 * (await Look.embedCursorImage(Look.DEFAULT)).cursor.image; // null
 * ```
 */
export async function embedCursorImage(look: Look): Promise<Look> {
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
 * Checks every declaration of a look against the browser's own CSS, and returns the look with each
 * one as the browser takes it: kebab-case names, and a bare number given its `px` where it needs
 * one. A property the browser doesn't know, or a value it won't take, throws with its name.
 *
 * ```ts
 * import * as Look from './look.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live page.
 * async function check(page: Page) {
 *   const look = { ...Look.DEFAULT, caption: { placement: 'top' as const, style: { borderRadius: 0 } } };
 *   return (await Look.validateCSS(page, look)).caption.style; // { 'border-radius': '0' }
 * }
 * ```
 */
export async function validateCSS(page: Page, look: Look): Promise<Look> {
  const check = async (part: string, style: Style, as?: string): Promise<Style> => {
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
  };
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
