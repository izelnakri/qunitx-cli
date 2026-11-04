import type { Style } from './tour/compose.ts';

/**
 * One slide of a Markdown deck: its HTML, the title its step is shown by, and speaker notes.
 *
 * ```ts
 * const slide: Slide = { html: '<h1>Why</h1>', title: 'Why', notes: null };
 * ```
 */
export interface Slide {
  /** The slide's content, rendered. */
  html: string;
  /** Its first heading's text, or `Slide n`. */
  title: string;
  /** Its speaker notes, or null. */
  notes: string | null;
}

// A line of three or more dashes alone separates two slides, as in reveal.js, Marp and Slidev.
const SEPARATOR = /^\s*-{3,}\s*$/m;
// `Note:` starts a slide's speaker notes, to its end: shown in the player, never on the slide.
const NOTES = /^Note:\s*/m;

/**
 * Splits a Markdown deck into slides and renders each with `marked` (CommonMark and GitHub's
 * tables, task lists and strikethrough), loaded only when a deck is recorded. A slide's title is
 * its first heading, or `Slide n`. Raw HTML in the Markdown is kept: the deck is the author's own.
 *
 * ```ts
 * import { parseSlides } from './slides.ts';
 *
 * // Defined, not invoked: loads marked.
 * async function titles() {
 *   const slides = await parseSlides('# Hello\n\nWorld\n\n---\n\n## Next\n\nNote: say why');
 *   return slides.map((slide) => [slide.title, slide.notes]); // [['Hello', null], ['Next', 'say why']]
 * }
 * ```
 */
export async function parseSlides(markdown: string): Promise<Slide[]> {
  const { Marked } = await import('marked');
  const marked = new Marked({ gfm: true });
  return markdown
    .split(SEPARATOR)
    .map((source) => source.trim())
    .filter(Boolean)
    .map((source, index) => {
      const split = source.search(NOTES);
      const body = split === -1 ? source : source.slice(0, split).trim();
      const notes = split === -1 ? null : source.slice(split).replace(NOTES, '').trim() || null;
      const heading = marked.lexer(body).find((token) => token.type === 'heading');
      return {
        html: marked.parse(body, { async: false }),
        title: heading && 'text' in heading ? plain(heading.text) : `Slide ${index + 1}`,
        notes,
      };
    });
}

// A heading's text without its inline Markdown: `**Why** it _matters_` is `Why it matters`.
function plain(text: string): string {
  return text.replace(/[*_`~]|!?\[([^\]]*)\]\([^)]*\)/g, (_match, label) => label ?? '').trim();
}

/**
 * The stylesheet a slide is drawn with: sized from the slide itself (container units), so it fits
 * a phone-sized recording as well as a 4K one. Selectors: `.slide`, and the Markdown's own
 * elements under it (`.slide h1`, `.slide pre`, `.slide img`…); an image slide is `.slide.image`.
 *
 * ```ts
 * import { SLIDE_CSS } from './slides.ts';
 *
 * SLIDE_CSS.includes('.slide h1'); // true
 * ```
 */
export const SLIDE_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: #fff; }
.slide { container-type: size; width: 100vw; height: 100vh; display: flex; flex-direction: column; justify-content: center;
  padding: 6cqh 8cqw; background: #fff; color: #1d2433; font: 400 clamp(14px, 3.2cqh, 40px)/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; overflow: hidden; }
.slide > :first-child { margin-top: 0; } .slide > :last-child { margin-bottom: 0; }
.slide h1 { font-size: 2.4em; line-height: 1.1; margin: 0 0 .4em; letter-spacing: -.02em; }
.slide h2 { font-size: 1.7em; line-height: 1.15; margin: 0 0 .5em; }
.slide h3 { font-size: 1.25em; margin: 0 0 .5em; }
.slide p, .slide ul, .slide ol, .slide table, .slide blockquote, .slide pre { margin: 0 0 .7em; }
.slide li + li { margin-top: .25em; }
.slide a { color: #3b5bdb; }
.slide code { font: .88em ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: #f1f3f5; padding: .1em .35em; border-radius: 4px; }
.slide pre { background: #11141c; color: #e9ecef; padding: 1em 1.2em; border-radius: 10px; overflow: hidden; font-size: .8em; line-height: 1.5; }
.slide pre code { background: none; padding: 0; color: inherit; font-size: 1em; }
.slide blockquote { border-left: 4px solid #5f3dc4; padding-left: 1em; color: #495057; }
.slide table { border-collapse: collapse; } .slide th, .slide td { border: 1px solid #dee2e6; padding: .3em .7em; text-align: left; }
.slide img { max-width: 100%; max-height: 60cqh; }
.slide.image { padding: 0; align-items: center; background: #11141c; }
.slide.image img { max-width: 100%; max-height: 100%; object-fit: contain; }
`;

/**
 * A page that shows one slide, or an image as one: the slide stylesheet, the recording's `css`
 * after it, and the slide's own `style`, inline, last of all.
 *
 * ```ts
 * import { slidePage } from './slides.ts';
 *
 * slidePage('<h1>Hi</h1>', { css: '.slide h1 { color: red; }', style: { background: '#000' } }).includes('background: #000'); // true
 * ```
 */
export function slidePage(
  content: string,
  options: { css?: string; style?: Style; image?: boolean } = {},
): string {
  const inline = Object.entries(options.style ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${kebab(name)}: ${value}`)
    .join('; ');
  return (
    `<!doctype html><html><head><meta charset="utf-8"><style>${SLIDE_CSS}</style>` +
    `<style>${options.css ?? ''}</style></head><body>` +
    `<main class="slide${options.image ? ' image' : ''}" style="${escapeAttribute(inline)}">${content}</main></body></html>`
  );
}

/**
 * The markup an image slide shows: the image, fit inside the slide.
 *
 * ```ts
 * import { imageSlide } from './slides.ts';
 *
 * imageSlide('data:image/png;base64,AAAA', 'Dashboard'); // '<img src="data:image/png;base64,AAAA" alt="Dashboard">'
 * ```
 */
export function imageSlide(source: string, alt: string): string {
  return `<img src="${escapeAttribute(source)}" alt="${escapeAttribute(alt)}">`;
}

function kebab(name: string): string {
  return name.startsWith('--')
    ? name
    : name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
