/**
 * The rest of the most recent line that starts with what has been typed — zsh's autosuggestion.
 *
 * Newest first, and it stops at the first hit: history is the one thing in a REPL that only grows,
 * and a suggestion is recomputed on every keystroke. Scanning all of it to pick the "best" match
 * would be work proportional to the session, on the hot path, for an answer nobody asked to be
 * ranked — the last thing you did is the thing you meant.
 *
 * Returns only the REMAINDER, so a caller can render it after the cursor without measuring
 * anything. Empty when nothing matches, when the line is empty, or when the only match is the line
 * itself — suggesting what is already typed is noise.
 *
 * ```ts
 * import { suggest } from './suggest.ts';
 *
 * suggest('doc', ['document.title', 'const a = 1']); // 'ument.title'
 * suggest('const a = 1', ['const a = 1']); // '' — nothing left to offer
 * suggest('', ['anything']); // '' — an empty line suggests nothing
 * ```
 */
export function suggest(line: string, history: readonly string[]): string {
  if (line === '') return '';

  for (const entry of history) {
    if (entry.length > line.length && entry.startsWith(line)) return entry.slice(line.length);
  }

  return '';
}
