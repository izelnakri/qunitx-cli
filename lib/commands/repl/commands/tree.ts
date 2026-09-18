import * as Files from '../../../repl/files.ts';
import { pathErrorLine, prefillPrompt, treeWithTally } from '../path-output.ts';
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
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return treeCommand.main(repl, '-L 2 lib'); // two levels of it, drawn
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Show a directory as a tree — `-L 2` for two levels, all the way down by default',
  aliases: ['ls'],
  main(repl, argument) {
    const { file, depth } = Files.pathAndDepth(argument.trim());
    const found = Files.resolve(file, repl.cwd);
    if (found.kind === 'directory') repl.log(treeWithTally(repl, file, depth));
    else if (found.kind === 'file') repl.log(red(`${file} is a file, not a directory`));
    else {
      repl.log(red(`${pathErrorLine(found, file)}`));

      return void (found.kind === 'missing' && prefillPrompt(repl, 'tree', found));
    }
  },
};
