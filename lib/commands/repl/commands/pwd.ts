import type { ReplCommand } from '../command.ts';

/**
 * `.pwd` — the directory every relative path here is resolved against.
 *
 * ```ts
 * import { command as pwdCommand } from './pwd.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return pwdCommand.main(repl, ''); // the directory paths resolve against
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Print the directory paths are resolved against',
  main(repl) {
    repl.write(`${repl.cwd}\n`);
    repl.prompt();
  },
};
