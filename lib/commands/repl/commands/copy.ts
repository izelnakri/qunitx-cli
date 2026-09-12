import { copyValue, nowhere } from '../values.ts';
import { blue, red } from '../../../utils/color.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.copy` — a value onto the clipboard.
 *
 * A function goes as the code that defines it, because that is the thing anybody copying a function
 * wants; everything else goes as the value the prompt would have printed.
 *
 * ```ts
 * import { command as copyCommand } from './copy.ts';
 *
 * copyCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Copy a value to the clipboard — a function goes as the code that defines it',
  main: async (repl, argument) => {
    const copied = await copyValue(repl.session, argument, repl.cwd);
    repl.write(copied === null ? red(`${nowhere(argument, 'copy')}\n`) : blue(copied));
    repl.prompt();
  },
};
