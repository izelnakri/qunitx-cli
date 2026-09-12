import { formatScope } from '../../../repl/scope.ts';
import { terminalWidth } from '../../../repl/columns.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.scope` — what this session has added to the page.
 *
 * Two commands rather than one, because a REPL is in one of two states and the answer differs:
 * running, where the interesting names are the ones you declared, and stopped at a breakpoint,
 * where they are the ones the frame can see ({@link ../commands/locals.ts}). Same format either way.
 *
 * ```ts
 * import { command as scopeCommand } from './scope.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return scopeCommand.main(repl, ''); // what this session declared
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'List what this session has added to the page, with values',
  async main(repl) {
    const listing = formatScope(await repl.session.scope(), terminalWidth(repl.server.output));
    repl.write(listing === '' ? 'Nothing declared yet\n' : `${listing}\n`);
    repl.prompt();
  },
};
