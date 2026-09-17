import { command as doc } from './doc.ts';
import { helpLines } from '../help.ts';
import { inStyle } from '../../../repl/terminal.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.help` — every command with nothing after it, and the documentation for whatever follows it.
 *
 * One question with two shapes, not two commands: "what can I type" and "what is this" are the
 * same reflex, and a prompt that answers only the first sends you looking for the name of the
 * second. `.h` is the same command, because that is what the hand types.
 *
 * The bare form says so on its way out. Somebody who does not know the second shape exists is
 * exactly the person typing `.h`, and the list is the only place they will be looking.
 *
 * The list is grouped rather than one row per name: `node:repl`'s own prints a row per NAME, and
 * this REPL has more names than commands — `.c`, `.s`, `.n`, `.e`, `.bt` and the rest. Folding the
 * aliases onto the line they are an alias of is the difference between one screenful and two of
 * the same sentences.
 *
 * ```ts
 * import { command as helpCommand } from './help.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return helpCommand.main(repl, 'double'); // the docs for it; bare, every command
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Every command with nothing after it; the documentation for whatever follows it',
  aliases: ['h'],
  main(repl, argument) {
    if (argument.trim() !== '') return doc.main(repl, argument);

    repl.log(helpLines(repl.server.commands, repl.palette));
    // The list is what `.help` is reached for, so it is also the only place anybody will find out
    // that it takes an argument. One row of thirty-five saying so is a row nobody reads.
    repl.log(
      inStyle(
        'Name anything after it for what that is — `.h double`, `.h window.fetch`',
        repl.palette.style('LineNr'),
      ),
    );
    repl.log(
      inStyle('Ctrl+C aborts the current expression, Ctrl+D exits', repl.palette.style('LineNr')),
    );
  },
};
