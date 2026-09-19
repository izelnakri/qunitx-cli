import { ESCAPE } from '../../../repl/terminal.ts';
import type { ReplCommand } from '../command.ts';

// `[H` puts the cursor home, `[2J` erases what is ON SCREEN. `[3J` would erase what has scrolled
// off it — the difference between clearing a terminal and losing the last hour of it — so it is
// deliberately absent, which is why scrolling still works afterwards.
//
// A constant, not a `clearScreen()` in the terminal module: it took no arguments, returned a fixed
// string, had one caller, and was named like something that does the clearing. It does not. The
// command does, by writing it.
const CLEAR_SCREEN = `${ESCAPE}[H${ESCAPE}[2J`;

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
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return clearCommand.main(repl, ''); // the screen, keeping the scrollback
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Clear the screen, keeping the scrollback and the unfinished input',
  main(repl) {
    // `write` and not `log`, which appends a newline — that would scroll the screen this just
    // cleared down by one line. Nothing at all on a pipe, where the escape would land in
    // whatever is reading it rather than on a screen.
    if (repl.interactive) repl.write(CLEAR_SCREEN);
  },
};
