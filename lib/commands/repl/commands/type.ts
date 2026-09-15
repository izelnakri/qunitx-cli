import { noSuchValue, typeOf } from '../describe.ts';
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
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return typeCommand.main(repl, 'double'); // the written signature, or the value's shape
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Say what type a value is — the signature where one is written, its shape otherwise',
  async main(repl, argument) {
    const said = await typeOf(repl.session, argument, repl.cwd, repl.palette);
    repl.log(said === null ? red(noSuchValue(argument, 'type')) : said);
  },
};
