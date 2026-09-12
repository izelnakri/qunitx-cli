import { blue, red } from '../../../utils/color.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.break` — one name, two jobs, told apart by whether anything follows it.
 *
 * `node:repl` has always used it for abandoning a half-typed block and every debugger has always
 * used it for setting a breakpoint, and both are what somebody typing that FORM means: bare, it is
 * the REPL's; with a place after it, it is the debugger's.
 *
 * ```ts
 * import { command as breakCommand } from './break.ts';
 *
 * breakCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Abandon the unfinished input, or stop the page at a line — `.break lib/a.ts:12`',
  main: async (repl, argument) => {
    if (argument.trim() === '') {
      repl.buffered = '';

      return repl.prompt();
    }
    const set = await repl.session.addBreakpoint(argument);
    repl.write(
      typeof set === 'string' ? red(`${set}\n`) : blue(`breakpoint ${set.index} at ${set.where}\n`),
    );
    repl.prompt();
  },
};
