import { highlight } from '../../../repl/highlight.ts';
import type { ReplCommand } from '../command.ts';
import type { Theme } from '../../../repl/theme.ts';

/**
 * `.history` — the last lines entered, numbered, the way a shell's does.
 *
 * Sixteen by default because that is about a screenful of context, and a count for when it is not.
 *
 * ```ts
 * import { command as historyCommand } from './history.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return historyCommand.main(repl, '40'); // the last forty lines
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Show the last lines entered — `.history 40` for more of them',
  main(repl, argument) {
    const asked = argument.trim() === '' ? HISTORY_SHOWN : Number(argument.trim());
    if (!Number.isInteger(asked) || asked < 1) {
      repl.log('Usage: .history [count]');

      return;
    }
    const entries = (repl.server as unknown as { history?: string[] }).history ?? [];
    repl.write(lastEntered(entries, asked, repl.palette));
  },
};

/** How many lines `.history` shows when it is not told — the number zsh settled on. */
const HISTORY_SHOWN = 16;

/**
 * The last `count` lines entered, numbered, the way `history` prints them.
 *
 * Oldest first, so the newest is nearest the prompt — reading up from where you are is how anybody
 * uses this. Numbered from one across what the session has, which is what it can honestly count:
 * history older than the file it was loaded from is not here to be numbered.
 *
 * ```ts
 * import { lastEntered } from './history.ts';
 *
 * lastEntered(['b', 'a'], 2, { painter: () => (t: string) => t }); // '1  a\n2  b\n' — newest last
 * lastEntered([], 16, { painter: () => (t: string) => t }); // '' — nothing entered yet
 * ```
 */
export function lastEntered(newestFirst: readonly string[], count: number, palette: Theme): string {
  const oldestFirst = [...newestFirst].reverse();
  const from = Math.max(0, oldestFirst.length - count);
  const gutter = String(oldestFirst.length).length;
  const dim = palette.painter('LineNr');

  return oldestFirst
    .slice(from)
    .map((line, index) => {
      const number = String(from + index + 1).padStart(gutter);

      // A dot command and a `:` shell line are not JavaScript, and painting them as if they were
      // colours `-L` as a type and `git` as a call.
      const code = /^\s*[.:]/.test(line) ? line : highlight(line, palette);

      return `${dim(number)}  ${code}\n`;
    })
    .join('');
}
