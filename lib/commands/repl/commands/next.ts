import { stepping } from '../debugging.ts';
import type { ReplCommand } from '../command.ts';

/** `.next` — one step, over the call rather than into it. gdb's `next`.
 *
 * ```ts
 * import { command as nextCommand } from './next.ts';
 *
 * nextCommand.aliases; // ['n'] — the same command under the names a hand reaches for
 * ```
 */
export const command: ReplCommand = {
  description: 'Run one step, over the next call rather than into it',
  aliases: ['n'],
  main: stepping('next', 'over'),
};
