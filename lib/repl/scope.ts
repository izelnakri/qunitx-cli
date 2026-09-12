import { plainLength, truncate } from './columns.ts';
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
