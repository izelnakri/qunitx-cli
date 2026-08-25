const ESCAPE = String.fromCharCode(27);
const RESET = `${ESCAPE}[0m`;
const ELLIPSIS = '…';

/**
 * The text with its colour taken off — what the terminal would show on a screen with none.
 *
 * Split on the escape rather than matched with a pattern: a regular expression for this needs a
 * literal control character in it, which every linter with an opinion about control characters
 * objects to, and it would be slower besides.
 *
 * ```ts
 * import { plain } from './columns.ts';
 *
 * plain(`${String.fromCharCode(27)}[33mhi${String.fromCharCode(27)}[0m`); // 'hi'
 * ```
 */
export function plain(text: string): string {
  if (!text.includes(ESCAPE)) return text;

  return text
    .split(ESCAPE)
    .map((part, index) => (index === 0 ? part : part.slice(part.indexOf('m') + 1)))
    .join('');
}

/**
 * Width as the terminal sees it — colour codes take columns nowhere but in the string.
 *
 * ```ts
 * import { plainLength } from './columns.ts';
 *
 * plainLength('hi'); // 2
 * plainLength(`${String.fromCharCode(27)}[33mhi${String.fromCharCode(27)}[0m`); // 2 — colour is free
 * ```
 */
export function plainLength(text: string): number {
  return plain(text).length;
}

/**
 * Cuts a line to `width` columns, counting what the terminal counts.
 *
 * The reset goes back on the end, so a value cut off mid-colour cannot leak its palette into
 * whatever the terminal draws next.
 *
 * ```ts
 * import { truncate } from './columns.ts';
 *
 * truncate('abcdef', 4); // 'abc…'
 * truncate('abc', 10); // 'abc' — what already fits is left alone
 * ```
 */
export function truncate(text: string, width: number): string {
  if (width <= 0 || plainLength(text) <= width) return text;

  let kept = '';
  let columns = 0;
  let index = 0;
  while (index < text.length && columns < width - 1) {
    if (text[index] !== ESCAPE) {
      kept += text[index++];
      columns += 1;
      continue;
    }
    // A colour code costs no columns, so it is copied whole and does not count towards the width.
    const end = text.indexOf('m', index);
    if (end === -1) break;
    kept += text.slice(index, end + 1);
    index = end + 1;
  }

  return `${kept}${ELLIPSIS}${RESET}`;
}

/**
 * Text wrapped in a style, or the text alone where there is no style to wrap it in.
 *
 * Every caller has the same two cases and the same reason for them: an unstyled theme should cost
 * no bytes, so a piped session stays text a script can compare rather than text with empty colour
 * codes in it.
 *
 * ```ts
 * import { paint } from './columns.ts';
 *
 * paint('hi', ''); // 'hi' — nothing to wrap it in
 * paint('hi', `${String.fromCharCode(27)}[33m`).endsWith(`${String.fromCharCode(27)}[0m`); // true
 * ```
 */
export function paint(text: string, style: string): string {
  return style === '' ? text : `${style}${text}${RESET}`;
}
