import * as Files from '../../../repl/files.ts';
import { command as tree } from './tree.ts';
import { reportBadPath } from '../report-bad-path.ts';
import { printValueDetails } from '../value-details.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.view` — whatever the name turns out to be: a file numbered, a directory as a tree, or a value
 * whole.
 *
 * The three are one command because the question is one question. `.view helper` is a fair thing
 * to type, and a name that is not a file is very likely a value.
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
    const { file } = Files.pathAndDepth(argument.trim());
    if (argument.trim() === '') {
      repl.log('Usage: .view <file>');

      return;
    }

    const found = Files.resolve(file, repl.cwd);
    if (found.kind === 'file') {
      repl.log(`${Files.numbered(found.contents, file, repl.palette)}`);

      return;
    }
    // A directory viewed IS a tree, so `.tree` answers rather than a second copy of it here —
    // the same delegation `.help` makes to `.doc`. The whole argument goes on, `-L 2` included.
    if (found.kind === 'directory') return tree.main(repl, argument);

    const said = await printValueDetails(repl, file);
    if (said !== null) {
      repl.log(`${said}`);

      return;
    }
    reportBadPath(repl, 'view', file, found);
  },
};
