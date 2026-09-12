import { HISTORY_SHOWN, recent } from '../history.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.history` — the last lines entered, numbered, the way a shell's does.
 *
 * Sixteen by default because that is about a screenful of context, and a count for when it is not.
 *
 * ```ts
 * import { command as historyCommand } from './history.ts';
 *
 * historyCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Show the last lines entered — `.history 40` for more of them',
  main: (repl, argument) => {
    const asked = argument.trim() === '' ? HISTORY_SHOWN : Number(argument.trim());
    if (!Number.isInteger(asked) || asked < 1) {
      repl.write('Usage: .history [count]\n');

      return repl.prompt();
    }
    const entries = (repl.server as unknown as { history?: string[] }).history ?? [];
    repl.write(recent(entries, asked, repl.palette));
    repl.prompt();
  },
};
