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
 * importCommand.aliases; // ['load'] — the same command under the names a hand reaches for
 * ```
 */
export const command: ReplCommand = {
  description: 'Bring a file into the page — `.import lib/a.ts` puts it in scope as `A`',
  aliases: ['load'],
  main: async (repl, argument) => {
    const [file, as] = argument.trim().split(/\s+/);
    if (file === undefined || file === '') {
      repl.write('Usage: .import <file> [name]\n');

      return repl.prompt();
    }
    const brought = await repl.session.importFile(file, as);
    if (typeof brought === 'string') repl.write(red(`${brought}\n`));
    else {
      const exported = brought.names.filter((known) => known !== brought.name);
      const also = exported.length === 0 ? '' : `, and ${exported.join(', ')}`;
      repl.write(blue(`${brought.name}${also}\n`));
    }
    repl.prompt();
  },
};
