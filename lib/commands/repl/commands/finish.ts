import { stepping } from '../debugging.ts';
import type { ReplCommand } from '../command.ts';

/** `.finish` — run until this frame returns, and stop in whoever called it. gdb's `finish`.
 *
 * ```ts
 * import { command as finishCommand } from './finish.ts';
 *
 * finishCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Run until the current frame returns',
  main: stepping('finish', 'out'),
};
