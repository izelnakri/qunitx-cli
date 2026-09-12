import { formatScope } from '../../../repl/scope.ts';
import { terminalWidth } from '../../../repl/columns.ts';
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
      repl.write('Not paused — `.scope` is what this session has declared\n');

      return repl.prompt();
    }
    const listing = formatScope(await repl.session.locals(), terminalWidth(repl.server.output));
    repl.write(listing === '' ? 'Nothing in scope here\n' : `${listing}\n`);
    repl.prompt();
  },
};
