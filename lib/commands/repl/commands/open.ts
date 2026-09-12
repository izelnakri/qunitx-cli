import { opening } from '../editor.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.open` — one command doing what `xdg-open` does.
 *
 * Nothing after it is the session's scratchpad; an address is the browser already running; anything
 * else is an editor, on the file a value is declared in or on the path itself. `node:repl`'s
 * `.editor` is dropped for it: a multi-line paste mode in a REPL that hands you a real editor is
 * the worse of two spellings of the same idea.
 *
 * ```ts
 * import { command as openCommand } from './open.ts';
 *
 * openCommand.aliases; // ['edit', 'e'] — the same command under the names a hand reaches for
 * ```
 */
export const command: ReplCommand = {
  description: 'Open a scratch buffer, or whatever follows: a value, a file, or an address',
  aliases: ['edit', 'e'],
  main: opening('open'),
};
