import { opening } from '../editor.ts';
import type { ReplCommand } from '../command.ts';

/** `.vim` — {@link ../commands/open.ts}, but in vim rather than whatever `$EDITOR` says.
 *
 * ```ts
 * import { command as vimCommand } from './vim.ts';
 *
 * vimCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Open a scratch buffer, or whatever follows: a value, a file, or an address',
  main: opening('vim', 'vim'),
};
