import type { ReplCommand } from '../command.ts';

/**
 * `.reload` — a fresh page, which is every binding and all page state gone.
 *
 * ```ts
 * import { command as reloadCommand } from './reload.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return reloadCommand.main(repl, ''); // a fresh page, and nothing in scope
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Reload the page — drops every binding and all page state',
  async main(repl) {
    repl.completions.stale();
    await repl.session.reload();
    repl.prompt();
  },
};
