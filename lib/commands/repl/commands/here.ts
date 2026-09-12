import { moving } from '../debugging.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.here` — which frame is being read, and nothing else: it takes no count.
 *
 * ```ts
 * import { command as hereCommand } from './here.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return hereCommand.main(repl, ''); // which frame is being read
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Say which frame is being read',
  main: moving('here', 0, false),
};
