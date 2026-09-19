import { scopeTable } from '../../../repl/scope.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.locals` — what the stopped frame can see, which is not what the session declared.
 *
 * ```ts
 * import { command as localsCommand } from './locals.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return localsCommand.main(repl, ''); // the stopped frame's own names
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'List what is in scope at a `debugger` breakpoint, with values',
  async main(repl) {
    if (!repl.session.pausedAt) {
      repl.log('Not paused — `.scope` is what this session has declared');

      return;
    }
    const listing = scopeTable(await repl.session.locals(), repl.width);
    repl.log(listing === '' ? 'Nothing in scope here' : listing);
  },
};
