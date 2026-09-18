import * as Files from '../../../repl/files.ts';
import { reportBadPath } from '../report-bad-path.ts';
import { red } from '../../../utils/color.ts';
import type { ReplCommand, ReplContext } from '../command.ts';

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
    else reportBadPath(repl, 'tree', file, found);
  },
};

/**
 * The tree, plus the tally `tree` prints under one, plus whatever the depth cap left out.
 *
 * `Files.tree` does the walking and the colouring; this is the two sentences under it, and they
 * are why it is here rather than in the engine — a listing that stops without saying so reads as
 * the whole answer, so the cut is said outright and names the flag that changes it.
 *
 * Private: `.tree` is the only command that draws one, and `.view` reaches it by asking `.tree`.
 */
function treeWithTally(repl: ReplContext, typed: string, depth: number): string {
  const { listing, counted, omitted } = Files.tree(typed, repl.cwd, repl.palette, depth);
  const tally = `${counted.directories} directories, ${counted.files} files`;
  const cut = omitted === 0 ? '' : ` — ${omitted} more not shown, \`-L\` to narrow`;

  return `${listing}\n\n${tally}${cut}`;
}
