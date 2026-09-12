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
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return backCommand.main(repl, '2'); // two frames back toward the caller
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Back toward the caller, which is back in execution order',
  main: moving('back', 1, true),
};
