import { blue, red } from '../../../utils/color.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.import` — a file brought into the page after the fact, under a name you can type.
 *
 * `.import` reads as the language does; `.load` is the name `node:repl` already had for putting a
 * file into a session, and this REPL's answer to it, since a browser cannot replay lines of Node.
 * One command under both names, because a hand that has typed one expects the other.
 *
 * ```ts
 * import { command as importCommand } from './import.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return importCommand.main(repl, 'lib/a.ts'); // in scope as `A`, plus its exports
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Bring a file into the page — `.import lib/a.ts` puts it in scope as `A`',
  aliases: ['load'],
  async main(repl, argument) {
    // `callItThis` rather than `as`, which is a TypeScript operator — `const [file, as] = …`
    // reads as a half-written type assertion, and the second word is a NAME, not a number.
    const [file, callItThis] = argument.trim().split(/\s+/);
    if (file === undefined || file === '') {
      repl.log('Usage: .import <file> [name]');

      return;
    }
    const brought = await repl.session.import(file, callItThis);
    if (typeof brought === 'string') repl.log(red(`${brought}`));
    else {
      const exported = brought.names.filter((known) => known !== brought.name);
      const also = exported.length === 0 ? '' : `, and ${exported.join(', ')}`;
      repl.log(blue(`${brought.name}${also}`));
    }
  },
};
