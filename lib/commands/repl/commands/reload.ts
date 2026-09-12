import type { ReplCommand } from '../command.ts';

/** `.reload` — a fresh page, which is every binding and all page state gone.
 *
 * ```ts
 * import { command as reloadCommand } from './reload.ts';
 *
 * reloadCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Reload the page — drops every binding and all page state',
  main: async (repl) => {
    repl.completions.stale();
    await repl.session.reload();
    repl.prompt();
  },
};
