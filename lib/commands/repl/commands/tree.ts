import fs from 'node:fs';
import path from 'node:path';
import { findPath, pathAndDepth } from '../typed-path.ts';
import { inStyle } from '../../../repl/terminal.ts';
import { red } from '../../../utils/color.ts';
import { reportBadPath } from '../report-bad-path.ts';
import type { ReplCommand, ReplContext } from '../command.ts';

// Deep enough to be worth calling unlimited, bounded enough that `.tree` in a project root cannot
// take the terminal with it. Whatever it leaves out, it SAYS it left out — a listing that quietly
// stops is a listing that lies about what is there.
const TREE_LIMIT = 5_000;

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
    const { file, depth } = pathAndDepth(argument.trim());
    const found = findPath(file, repl.cwd);
    if (found.kind === 'directory') repl.log(drawTree(repl, file, depth));
    else if (found.kind === 'file') repl.log(red(`${file} is a file, not a directory`));
    else reportBadPath(repl, 'tree', file, found);
  },
};

/**
 * A directory drawn the way `tree` draws one, with the two sentences `tree` puts under it.
 *
 * ```
 * lib/
 * ├── api/
 * │   └── index.ts
 * └── repl/
 *     └── session.ts
 *
 * 2 directories, 2 files
 * ```
 *
 * All the way down unless `depth` says otherwise, where 1 is the directory's own contents. Hidden
 * entries are left out, as `tree` leaves them out, which is also what keeps `.git` from being most
 * of the answer. Symlinks are named but not followed — a link into a parent is a tree with no end.
 *
 * The tally and the "there was more" line are not decoration: a listing that stops without saying
 * so reads as the whole answer, so the cut is said outright and names the flag that changes it.
 *
 * Exported for its own test, which can walk a temporary directory and read the drawing back;
 * `.tree` is its only caller, and `.view` reaches it by asking `.tree`.
 *
 * ```ts
 * import { drawTree } from './tree.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it reads the filesystem and the terminal's colours.
 * function example(repl: ReplContext) {
 *   return drawTree(repl, 'lib', 1); // ends with '3 directories, 12 files'
 * }
 * ```
 */
export function drawTree(repl: ReplContext, root: string, depth: number): string {
  const directoryStyle = repl.palette.style('Directory');
  const branchStyle = repl.palette.style('LineNr');
  const counted = { directories: 0, files: 0 };
  const lines = [inStyle(root.endsWith('/') ? root : `${root}/`, directoryStyle)];
  let omitted = 0;

  const walk = (directory: string, prefix: string, level: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      // A directory that cannot be read is a leaf, not a failure — one unreadable subdirectory is
      // no reason to refuse the rest of the tree.
      return;
    }
    const visible = entries
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((left, right) => (left.name < right.name ? -1 : 1));

    for (const [index, entry] of visible.entries()) {
      if (lines.length > TREE_LIMIT) {
        omitted += visible.length - index;

        return;
      }
      const last = index === visible.length - 1;
      const isDirectory = entry.isDirectory();
      counted[isDirectory ? 'directories' : 'files'] += 1;
      const name = inStyle(
        `${entry.name}${isDirectory ? '/' : ''}`,
        isDirectory ? directoryStyle : '',
      );
      lines.push(`${inStyle(`${prefix}${last ? '└── ' : '├── '}`, branchStyle)}${name}`);
      if (isDirectory && level < depth) {
        walk(path.join(directory, entry.name), `${prefix}${last ? '    ' : '│   '}`, level + 1);
      }
    }
  };

  walk(path.resolve(repl.cwd, root), '', 1);
  const tally = `${counted.directories} directories, ${counted.files} files`;
  const cut = omitted === 0 ? '' : ` — ${omitted} more not shown, \`-L\` to narrow`;

  return `${lines.join('\n')}\n\n${tally}${cut}`;
}
