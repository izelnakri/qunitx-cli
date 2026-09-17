import { copyValue } from '../clipboard.ts';
import { noSuchValue } from '../describe-value.ts';
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
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return copyCommand.main(repl, 'double'); // the code that defines it, onto the clipboard
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Copy a value to the clipboard — a function goes as the code that defines it',
  async main(repl, argument) {
    const copied = await copyValue(repl.session, argument, repl.cwd);
    repl.log(copied === null ? red(noSuchValue(argument, 'copy')) : blue(copied));
  },
};
