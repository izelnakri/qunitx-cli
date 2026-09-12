import * as Files from '../../../repl/files.ts';
import { pathProblem, retype } from '../browsing.ts';
import { red } from '../../../utils/color.ts';
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
 * catCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Print a file, numbered and highlighted',
  main: (repl, argument) => {
    const { path: typed } = Files.target(argument.trim());
    if (argument.trim() === '') {
      repl.write('Usage: .cat <file>\n');

      return repl.prompt();
    }

    const found = Files.read(typed, repl.cwd);
    if (found.kind === 'file') {
      repl.write(`${Files.numbered(found.contents, typed, repl.palette)}\n`);

      return repl.prompt();
    }
    repl.write(red(`${pathProblem(found, typed)}\n`));
    repl.prompt();
    retype('cat', found, repl);
  },
};
