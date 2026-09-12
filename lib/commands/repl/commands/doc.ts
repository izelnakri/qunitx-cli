import { describeValue, nowhere } from '../values.ts';
import { red } from '../../../utils/color.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.doc` — where a value is written, what was said above it, and how to call it.
 *
 * `.doc` for what it is, `.explain` for what you want from it, `.d` for the hand. The whole of it,
 * body and all, is {@link ../commands/view.ts}.
 *
 * ```ts
 * import { command as docCommand } from './doc.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return docCommand.main(repl, 'double'); // where it is written, the comment, the signature
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Show a value’s signature, where it is written, and the comment above it',
  aliases: ['explain', 'd'],
  async main(repl, argument) {
    const said = await describeValue(repl.session, argument, repl.cwd, repl.palette, {
      body: false,
    });
    repl.write(said === null ? red(`${nowhere(argument, 'doc')}\n`) : `${said}\n`);
    repl.prompt();
  },
};
