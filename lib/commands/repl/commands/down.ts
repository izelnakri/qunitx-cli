import { moving } from '../debugging.ts';
import type { ReplCommand } from '../command.ts';

/** `.down` — back toward where the page actually stopped.
 *
 * ```ts
 * import { command as downCommand } from './down.ts';
 *
 * downCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Go back toward the frame this one called — `.down 2` for two',
  main: moving('down', -1, true),
};
