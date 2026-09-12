import { nowhere, typeOfValue } from '../values.ts';
import { red } from '../../../utils/color.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.type` — what TypeScript would call it.
 *
 * The written type where there is one, and the value's own shape where there is not: a function in
 * a file you can read HAS a type, spelled out by whoever wrote it, and inventing a structural one
 * for it would be answering a question nobody asked.
 *
 * ```ts
 * import { command as typeCommand } from './type.ts';
 *
 * typeCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Say what type a value is — the signature where one is written, its shape otherwise',
  main: async (repl, argument) => {
    const said = await typeOfValue(repl.session, argument, repl.cwd, repl.palette);
    repl.write(said === null ? red(`${nowhere(argument, 'type')}\n`) : `${said}\n`);
    repl.prompt();
  },
};
