import { clearScreen } from '../output.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.clear` — the screen, and nothing else.
 *
 * What every shell means by it, rather than `node:repl`'s "break, and drop the local context":
 * there is no local context here, and a prompt that has scrolled past what you were reading is the
 * thing anybody actually wants cleared. The half-typed input survives, as it does in a shell.
 *
 * ```ts
 * import { command as clearCommand } from './clear.ts';
 *
 * clearCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Clear the screen, keeping the scrollback and the unfinished input',
  main: (repl) => {
    // Nothing to clear on a pipe, and the escape would land in whatever is reading it.
    if (repl.interactive) repl.write(clearScreen());
    repl.prompt();
  },
};
