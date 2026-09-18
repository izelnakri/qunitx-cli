import { command as cat } from './cat.ts';
import { command as tree } from './tree.ts';
import { findPath, pathAndDepth } from '../typed-path.ts';
import { printValueDetails } from '../value-details.ts';
import { reportBadPath } from '../report-bad-path.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.view` — whatever the name turns out to be: a file numbered, a directory as a tree, or a value
 * whole.
 *
 * The three are one command because the question is one question. `.view helper` is a fair thing
 * to type, and a name that is not a file is very likely a value.
 *
 * Which means this command's whole job is asking, in order, and then handing off — a file IS what
 * `.cat` prints and a directory IS what `.tree` draws, so it asks them rather than keeping a
 * second copy of either. The same delegation `.help` makes to `.doc`.
 *
 * ```ts
 * import { command as viewCommand } from './view.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return viewCommand.main(repl, 'double'); // the whole of it, body and all
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Show whatever it names: a file numbered, a directory as a tree, or a value whole',
  aliases: ['v'],
  async main(repl, argument) {
    if (argument.trim() === '') {
      repl.log('Usage: .view <file>');

      return;
    }

    // The whole argument goes on, `-L 2` included — only the path is needed to decide who answers.
    const { file } = pathAndDepth(argument.trim());
    const found = findPath(file, repl.cwd);
    if (found.kind === 'file') return cat.main(repl, argument);
    if (found.kind === 'directory') return tree.main(repl, argument);

    const said = await printValueDetails(repl, file);
    if (said !== null) {
      repl.log(said);

      return;
    }
    reportBadPath(repl, 'view', file, found);
  },
};
