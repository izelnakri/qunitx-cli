import * as Files from '../../../repl/files.ts';
import { pathProblem, retype, showTree } from '../browsing.ts';
import { red } from '../../../utils/color.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.tree` — a directory, drawn.
 *
 * Only ever a tree, so a file says so rather than being quietly printed: half the value of a narrow
 * command is that it refuses what it is not for. `.ls` because that is what the hand types to see
 * what is in a directory, and `-L 1` is the listing it means by it.
 *
 * ```ts
 * import { command as treeCommand } from './tree.ts';
 *
 * treeCommand.aliases; // ['ls'] — the same command under the names a hand reaches for
 * ```
 */
export const command: ReplCommand = {
  description: 'Show a directory as a tree — `-L 2` for two levels, all the way down by default',
  aliases: ['ls'],
  main: (repl, argument) => {
    const { depth, path: typed } = Files.target(argument.trim());
    const found = Files.read(typed, repl.cwd);
    if (found.kind === 'directory') repl.write(showTree(typed, repl.cwd, repl.palette, depth));
    else if (found.kind === 'file') repl.write(red(`${typed} is a file, not a directory\n`));
    else {
      repl.write(red(`${pathProblem(found, typed)}\n`));
      repl.prompt();

      return void (found.kind === 'missing' && retype('tree', found, repl));
    }
    repl.prompt();
  },
};
