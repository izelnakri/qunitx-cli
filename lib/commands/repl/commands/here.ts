import { moving } from '../debugging.ts';
import type { ReplCommand } from '../command.ts';

/** `.here` — which frame is being read, and nothing else: it takes no count.
 *
 * ```ts
 * import { command as hereCommand } from './here.ts';
 *
 * hereCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Say which frame is being read',
  main: moving('here', 0, false),
};
