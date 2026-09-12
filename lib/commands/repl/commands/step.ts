import { stepping } from '../debugging.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.step` — one step, into whatever the line calls. gdb's `step`.
 *
 * ```ts
 * import { command as stepCommand } from './step.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return stepCommand.main(repl, ''); // one step, into the next call
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Run one step, entering the next call',
  aliases: ['s'],
  main: stepping('step', 'into'),
};
