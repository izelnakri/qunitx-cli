import { stepping } from '../debugging.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.finish` — run until this frame returns, and stop in whoever called it. gdb's `finish`.
 *
 * ```ts
 * import { command as finishCommand } from './finish.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return finishCommand.main(repl, ''); // runs until this frame returns
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Run until the current frame returns',
  main: stepping('finish', 'out'),
};
