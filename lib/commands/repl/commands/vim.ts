import { openingIn } from '../editor.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.vim` — {@link ../commands/open.ts}, but in vim rather than whatever `$EDITOR` says.
 *
 * ```ts
 * import { command as vimCommand } from './vim.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return vimCommand.main(repl, ''); // the scratch buffer, in vim
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Open a scratch buffer, or whatever follows: a value, a file, or an address',
  main: openingIn('vim'),
};
