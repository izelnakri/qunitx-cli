import * as Files from '../../../repl/files.ts';
import { reportBadPath } from '../report-bad-path.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.cat` — a file, numbered and highlighted, without leaving the prompt.
 *
 * Only ever a file. `cat` on a directory is an error everywhere, and a name that is not a path is
 * not something `cat` has ever meant; {@link ../commands/view.ts} is the one that shows whatever is
 * there.
 *
 * ```ts
 * import { command as catCommand } from './cat.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return catCommand.main(repl, 'lib/repl/files.ts'); // the file, numbered and highlighted
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Print a file, numbered and highlighted',
  main(repl, argument) {
    const { file } = Files.pathAndDepth(argument.trim());
    if (argument.trim() === '') {
      repl.log('Usage: .cat <file>');

      return;
    }

    const found = Files.resolve(file, repl.cwd);
    if (found.kind === 'file') {
      repl.log(`${Files.numbered(found.contents, file, repl.palette)}`);

      return;
    }
    reportBadPath(repl, 'cat', file, found);
  },
};
