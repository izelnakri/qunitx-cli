import { towardCaller } from '../frames.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.up` — toward whoever called this. Up the stack, which grows downwards.
 *
 * ```ts
 * import { command as upCommand } from './up.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return upCommand.main(repl, '2'); // two frames toward the caller
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Go toward the frame that called this one — `.up 2` for two',
  main: towardCaller('up'),
};
