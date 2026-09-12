import { moving } from '../debugging.ts';
import type { ReplCommand } from '../command.ts';

/** `.up` — toward whoever called this. Up the stack, which grows downwards.
 *
 * ```ts
 * import { command as upCommand } from './up.ts';
 *
 * upCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Go toward the frame that called this one — `.up 2` for two',
  main: moving('up', 1, true),
};
