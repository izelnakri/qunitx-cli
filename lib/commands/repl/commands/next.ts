import { stepOverNextCall } from '../frames.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.next` — one step, over the call rather than into it. gdb's `next`.
 *
 * ```ts
 * import { command as nextCommand } from './next.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return nextCommand.main(repl, ''); // one step, over the next call
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Run one step, over the next call rather than into it',
  aliases: ['n'],
  main: stepOverNextCall,
};
