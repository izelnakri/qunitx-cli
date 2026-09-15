import { toFrameNumber } from '../frames.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.frame` — which frame is being read, or an absolute one to go to.
 *
 * ```ts
 * import { command as frameCommand } from './frame.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return frameCommand.main(repl, '1'); // reads frame 1
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Say which frame is being read, or go to one — `.frame 1`',
  main: toFrameNumber('frame'),
};
