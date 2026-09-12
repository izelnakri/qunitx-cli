import { helpLines } from '../help.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.help` — every command, one line each.
 *
 * `node:repl`'s own prints a row per NAME, and this REPL has more names than commands — `.c`, `.s`,
 * `.n`, `.e`, `.bt` and the rest. Gathering the aliases onto the line they are an alias of is the
 * difference between one screenful and two of the same sentences.
 *
 * ```ts
 * import { command as helpCommand } from './help.ts';
 *
 * helpCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Print this list of commands',
  main: (repl) => {
    repl.write(`${helpLines(repl.server.commands, repl.palette)}\n`);
    repl.write('Press Ctrl+C to abort the current expression, Ctrl+D to exit\n');
    repl.prompt();
  },
};
