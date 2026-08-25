import type { ScopeEntry } from './session.ts';

/**
 * A scope as a human reads it: one name per line, its value beside it, where it came from after.
 *
 * ```ts
 * import { formatScope } from './scope.ts';
 *
 * formatScope([{ name: 'label', value: "'one'", where: 'line 1' }], 80);
 * // "label  'one'  line 1"
 * formatScope([], 80); // '' — the caller says what nothing means, since the two commands differ
 * ```
 */
export function formatScope(entries: readonly ScopeEntry[], width: number): string {
  if (entries.length === 0) return '';

  const column = Math.max(...entries.map((entry) => entry.name.length));

  return entries
    .map((entry) => {
      const name = entry.name.padEnd(column);
      // One entry is one line, so a value the renderer broke across several is pulled back onto
      // one. A scope listing is for finding the name you meant, not for reading an object graph —
      // that is what typing the name does.
      const value = entry.value.replace(/\s*\n\s*/g, ' ');
      const where = entry.where === '' ? '' : `  ${DIM}${entry.where}${RESET}`;

      return truncate(`${name}  ${value}`, width - plainLength(where)) + where;
    })
    .join('\n');
}

const ESCAPE = String.fromCharCode(27);
const DIM = `${ESCAPE}[90m`;
const RESET = `${ESCAPE}[0m`;
const ELLIPSIS = '…';

/**
 * Cuts a line to `width` columns, counting what the terminal counts.
 *
 * Colour is measured as zero because that is what it is worth on screen, and the reset is put back
 * on the end so a value cut mid-colour cannot leak its palette into the rest of the terminal.
 */
function truncate(text: string, width: number): string {
  if (width <= 0 || plainLength(text) <= width) return text;

  let kept = '';
  let columns = 0;
  let index = 0;
  while (index < text.length && columns < width - 1) {
    if (text[index] !== ESCAPE) {
      kept += text[index++];
      columns++;
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

/** Width as the terminal sees it — colour codes take columns nowhere but in the string. */
function plainLength(text: string): number {
  if (!text.includes(ESCAPE)) return text.length;

  return text
    .split(ESCAPE)
    .map((part, index) => (index === 0 ? part.length : part.slice(part.indexOf('m') + 1).length))
    .reduce((total, length) => total + length, 0);
}
