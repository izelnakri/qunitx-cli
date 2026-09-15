import type { ReplCommand } from '../command.ts';

/**
 * `.reload` — the code again, your bindings gone.
 *
 * Every file this session loaded is evaluated again, which is the point: it is how you pick up an
 * edit without losing the tab. What you typed at the prompt does not come back — `let answer = 41`
 * is not code on disk, and restoring it would make this mean "reload, except keep my mistakes".
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
  description: 'Reload the page — every module again, every binding gone',
  async main(repl) {
    repl.completions.stale();
    const brought = await repl.session.reload();
    repl.log(brought.length === 0 ? 'Reloaded' : `Reloaded, with ${brought.join(', ')}`);
  },
};
