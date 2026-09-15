import type { ReplCommand } from '../command.ts';

/**
 * `.breakpoints` — what this session has asked the page to stop on, and their numbers.
 *
 * ```ts
 * import { command as breakpointsCommand } from './breakpoints.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return breakpointsCommand.main(repl, ''); // lists them, numbered
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'List the breakpoints this session has set',
  main(repl) {
    const set = repl.session.breakpoints();
    repl.log(
      set.length === 0
        ? 'No breakpoints'
        : set.map(({ index, where }) => `${index}  ${where}`).join('\n'),
    );
  },
};
