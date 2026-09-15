import type { ReplCommand } from '../command.ts';

/**
 * `.continue` — let a stopped page carry on.
 *
 * The name every debugger uses, and the one the pause itself offers. `.resume` stays because it is
 * what this REPL shipped with, and a command that used to work should not stop working over a
 * rename; `.c` because that is what it is in gdb, and what the hand types after the fifth
 * breakpoint.
 *
 * ```ts
 * import { command as continueCommand } from './continue.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return continueCommand.main(repl, ''); // the page carries on
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Let a page paused at a `debugger` statement carry on',
  aliases: ['c', 'resume'],
  async main(repl) {
    if (!repl.session.pausedAt) repl.log('Not paused');
    await repl.session.continue();
  },
};
