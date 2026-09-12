import { command as doc } from './doc.ts';
import { command as help } from './help.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.h` — one key for both questions somebody asks a prompt: what can I type, and what is this.
 *
 * ```ts
 * import { command as hCommand } from './h.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return hCommand.main(repl, 'double'); // the docs for it; bare, the help
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Help with nothing after it; the documentation for whatever follows it',
  main(repl, argument) {
    const asking = argument.trim() === '' ? help : doc;
    asking.main(repl, argument);
  },
};
