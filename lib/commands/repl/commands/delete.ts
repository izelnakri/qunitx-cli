import { red } from '../../../utils/color.ts';
import { buildCommand } from './http.ts';
import type { ReplCommand } from '../command.ts';

/** The HTTP half, built once — `.delete <url>` is a DELETE like any other verb command. */
const deleting = buildCommand('DELETE');

/**
 * `.delete` — one name, two jobs, told apart by what follows it, exactly as `.break` is.
 *
 * A breakpoint is deleted by its NUMBER, and a URL is never a number. `.delete 1` removes the
 * first breakpoint; `.delete /api/users/1` sends the request. Nothing else could be meant by
 * either form, which is the same test `.break` passes: bare it is the REPL's, with a place after
 * it it is the debugger's.
 *
 * The alternative was `.del` for one of them, and a five-verb family where four are spelled out
 * and the fifth is abbreviated is a family nobody can remember the shape of.
 *
 * No number is not "all breakpoints". Deleting everything by accident is a worse mistake than
 * typing one more character, and there is no confirmation here to catch it.
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
  description: 'Remove a breakpoint by number, or send a DELETE — `.delete 1`, `.delete /users/1`',
  async main(repl, argument) {
    const typed = argument.trim();
    // Anything that is not a whole number is an address: breakpoints are numbered from 1, and no
    // URL has ever been spelled `7`.
    if (typed !== '' && !/^\d+$/.test(typed)) return deleting.main(repl, argument);

    const index = typed === '' ? 0 : Number(typed);
    if (!Number.isInteger(index) || index < 1) {
      repl.log('Usage: .delete <breakpoint number>, or .delete <url> to send one');

      return;
    }
    if (!(await repl.session.removeBreakpoint(index))) repl.log(red(`No breakpoint ${index}`));
  },
};
