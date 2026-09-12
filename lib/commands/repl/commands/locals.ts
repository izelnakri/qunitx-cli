import { formatScope } from '../../../repl/scope.ts';
import { terminalWidth } from '../../../repl/columns.ts';
import type { ReplCommand } from '../command.ts';

/** `.locals` — what the stopped frame can see, which is not what the session declared.
 *
 * ```ts
 * import { command as localsCommand } from './locals.ts';
 *
 * localsCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'List what is in scope at a `debugger` breakpoint, with values',
  main: async (repl) => {
    if (!repl.session.pausedAt) {
      repl.write('Not paused — `.scope` is what this session has declared\n');

      return repl.prompt();
    }
    const listing = formatScope(await repl.session.locals(), terminalWidth(repl.server.output));
    repl.write(listing === '' ? 'Nothing in scope here\n' : `${listing}\n`);
    repl.prompt();
  },
};
