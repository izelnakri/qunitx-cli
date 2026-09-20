import { openingIn } from '../editor.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.vi` — {@link ../commands/open.ts}, but in vi rather than whatever `$EDITOR` says.
 *
 * ```ts
 * import { command as viCommand } from './vi.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return viCommand.main(repl, ''); // the scratch buffer, in vi
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Open a scratch buffer, or whatever follows: a value, a file, or an address',
  main: openingIn('vi'),
};
