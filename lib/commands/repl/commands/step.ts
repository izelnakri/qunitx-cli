import { stepping } from '../debugging.ts';
import type { ReplCommand } from '../command.ts';

/** `.step` — one step, into whatever the line calls. gdb's `step`.
 *
 * ```ts
 * import { command as stepCommand } from './step.ts';
 *
 * stepCommand.aliases; // ['s'] — the same command under the names a hand reaches for
 * ```
 */
export const command: ReplCommand = {
  description: 'Run one step, entering the next call',
  aliases: ['s'],
  main: stepping('step', 'into'),
};
