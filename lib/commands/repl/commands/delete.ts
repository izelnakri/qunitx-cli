import { count } from '../debugging.ts';
import { red } from '../../../utils/color.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.delete` — one breakpoint, by its number.
 *
 * No number is not "all of them". Deleting everything by accident is a worse mistake than typing
 * one more character, and there is no confirmation here to catch it.
 *
 * ```ts
 * import { command as deleteCommand } from './delete.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return deleteCommand.main(repl, '1'); // removes breakpoint 1
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Remove a breakpoint by its number — `.delete 1`',
  async main(repl, argument) {
    const index = count(argument, 0);
    if (index === null || index < 1) {
      repl.write('Usage: .delete <number>\n');

      return repl.prompt();
    }
    if (!(await repl.session.removeBreakpoint(index))) repl.write(red(`No breakpoint ${index}\n`));
    repl.prompt();
  },
};
