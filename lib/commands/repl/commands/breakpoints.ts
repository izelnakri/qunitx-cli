import type { ReplCommand } from '../command.ts';

/** `.breakpoints` — what this session has asked the page to stop on, and their numbers.
 *
 * ```ts
 * import { command as breakpointsCommand } from './breakpoints.ts';
 *
 * breakpointsCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'List the breakpoints this session has set',
  main: (repl) => {
    const set = repl.session.breakpoints();
    repl.write(
      set.length === 0
        ? 'No breakpoints\n'
        : `${set.map(({ index, where }) => `${index}  ${where}`).join('\n')}\n`,
    );
    repl.prompt();
  },
};
