import { moving } from '../debugging.ts';
import type { ReplCommand } from '../command.ts';

/** `.frame` — which frame is being read, or an absolute one to go to.
 *
 * ```ts
 * import { command as frameCommand } from './frame.ts';
 *
 * frameCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Say which frame is being read, or go to one — `.frame 1`',
  main: moving('frame', 0, true),
};
