import type { ReplCommand } from '../command.ts';

/** `.pwd` — the directory every relative path here is resolved against.
 *
 * ```ts
 * import { command as pwdCommand } from './pwd.ts';
 *
 * pwdCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Print the directory paths are resolved against',
  main: (repl) => {
    repl.write(`${repl.cwd}\n`);
    repl.prompt();
  },
};
