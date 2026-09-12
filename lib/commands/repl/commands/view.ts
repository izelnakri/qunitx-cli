import * as Files from '../../../repl/files.ts';
import { pathProblem, retype, showTree } from '../browsing.ts';
import { describeValue } from '../values.ts';
import { red } from '../../../utils/color.ts';
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
 * viewCommand.aliases; // ['v'] — the same command under the names a hand reaches for
 * ```
 */
export const command: ReplCommand = {
  description: 'Show whatever it names: a file numbered, a directory as a tree, or a value whole',
  aliases: ['v'],
  main: async (repl, argument) => {
    const { depth, path: typed } = Files.target(argument.trim());
    if (argument.trim() === '') {
      repl.write('Usage: .view <file>\n');

      return repl.prompt();
    }

    const found = Files.read(typed, repl.cwd);
    if (found.kind === 'file') {
      repl.write(`${Files.numbered(found.contents, typed, repl.palette)}\n`);

      return repl.prompt();
    }
    if (found.kind === 'directory') {
      repl.write(showTree(typed, repl.cwd, repl.palette, depth));

      return repl.prompt();
    }

    const said = await describeValue(repl.session, typed, repl.cwd, repl.palette, { body: true });
    if (said !== null) {
      repl.write(`${said}\n`);

      return repl.prompt();
    }
    repl.write(red(`${pathProblem(found, typed)}\n`));
    repl.prompt();
    retype('view', found, repl);
  },
};
