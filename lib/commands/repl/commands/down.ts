import { moving } from '../debugging.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.down` — back toward where the page actually stopped.
 *
 * ```ts
 * import { command as downCommand } from './down.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return downCommand.main(repl, '1'); // one frame back toward where it stopped
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Go back toward the frame this one called — `.down 2` for two',
  main: moving('down', -1, true),
};
