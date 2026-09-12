import { opening } from '../editor.ts';
import type { ReplCommand } from '../command.ts';

/** `.nvim` — {@link ../commands/open.ts}, but in nvim rather than whatever `$EDITOR` says.
 *
 * ```ts
 * import { command as nvimCommand } from './nvim.ts';
 *
 * nvimCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Open a scratch buffer, or whatever follows: a value, a file, or an address',
  main: opening('nvim', 'nvim'),
};
