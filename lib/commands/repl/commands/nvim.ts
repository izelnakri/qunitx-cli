import { opening } from '../editor.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.nvim` — {@link ../commands/open.ts}, but in nvim rather than whatever `$EDITOR` says.
 *
 * ```ts
 * import { command as nvimCommand } from './nvim.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return nvimCommand.main(repl, ''); // the scratch buffer, in nvim
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Open a scratch buffer, or whatever follows: a value, a file, or an address',
  main: opening('nvim', 'nvim'),
};
