import { opening } from '../editor.ts';
import type { ReplCommand } from '../command.ts';

/** `.vi` — {@link ../commands/open.ts}, but in vi rather than whatever `$EDITOR` says.
 *
 * ```ts
 * import { command as viCommand } from './vi.ts';
 *
 * viCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Open a scratch buffer, or whatever follows: a value, a file, or an address',
  main: opening('vi', 'vi'),
};
