import { moving } from '../debugging.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.back` — the same direction as `.up`, under the name that says why.
 *
 * "Back" is about execution order rather than about the stack: the caller is where you came FROM,
 * and that is what somebody typing `.back` means.
 *
 * ```ts
 * import { command as backCommand } from './back.ts';
 *
 * backCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Back toward the caller, which is back in execution order',
  main: moving('back', 1, true),
};
