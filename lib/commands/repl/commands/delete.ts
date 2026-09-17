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
    // Breakpoints are numbered from 1, so a bare `.delete` has nothing to remove and says so.
    const typed = argument.trim();
    const index = typed === '' ? 0 : Number(typed);
    if (!Number.isInteger(index) || index < 1) {
      repl.log('Usage: .delete <number>');

      return;
    }
    if (!(await repl.session.removeBreakpoint(index))) repl.log(red(`No breakpoint ${index}`));
  },
};
