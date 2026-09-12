import { command as doc } from './doc.ts';
import { command as help } from './help.ts';
import type { ReplCommand } from '../command.ts';

/** `.h` — one key for both questions somebody asks a prompt: what can I type, and what is this.
 *
 * ```ts
 * import { command as hCommand } from './h.ts';
 *
 * hCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Help with nothing after it; the documentation for whatever follows it',
  main: (repl, argument) => {
    const asking = argument.trim() === '' ? help : doc;
    asking.main(repl, argument);
  },
};
