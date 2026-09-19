import path from 'node:path';
import { findPath, getPathAndDepth } from '../path-argument.ts';
import { highlight } from '../../../repl/highlight.ts';
import { readIfThere } from '../editor.ts';
import { red } from '../../../utils/color.ts';
import { reportBadPath } from '../report-bad-path.ts';
import type { ReplCommand } from '../command.ts';
import type { Theme } from '../../../repl/theme.ts';

// Highlighted only where the highlighter knows the language. A `.md` file run through a JavaScript
// tokenizer comes out with prose coloured as keywords, which is worse than not colouring it.
const HIGHLIGHTED = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.json',
]);

/**
 * `.cat` — a file printed, numbered and highlighted.
 *
 * ```ts
 * import { command as catCommand } from './cat.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return catCommand.main(repl, 'lib/repl/session.ts'); // the file, numbered and highlighted
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Print a file, numbered and highlighted',
  main(repl, argument) {
    const { file } = getPathAndDepth(argument.trim());
    if (argument.trim() === '') {
      repl.log('Usage: .cat <file>');

      return;
    }

    const found = findPath(file, repl.cwd);
    if (found.kind !== 'file') {
      reportBadPath(repl, 'cat', file, found);

      return;
    }
    // The read is here rather than in `findPath` because `.cat` is the only command that wants the
    // bytes — `.view` asks what a path is and then hands the whole line to this one.
    const contents = readIfThere(path.resolve(repl.cwd, file));
    if (contents === null) {
      repl.log(red(`cannot read ${file}`));

      return;
    }
    repl.log(withLineNumbers(contents, file, repl.palette));
  },
};

/**
 * A file with its lines numbered, the way anybody quoting one writes them down.
 *
 * ```
 * 1 | let something = 'something';
 * 2 | function me() {
 * ```
 *
 * Numbers are right-aligned to the longest of them, so the gutter is a straight edge and the code
 * starts in one column rather than drifting at line 100.
 *
 * Exported for its own test — `.cat` is its only caller, and a unit test can hand it two strings
 * instead of a terminal and a file on disk.
 *
 * ```ts
 * import { withLineNumbers } from './cat.ts';
 *
 * const plain = { painter: () => (text: string) => text };
 * withLineNumbers('a\nb', 'x.txt', plain); // '1 | a\n2 | b' — the gutter is themed too
 * ```
 */
export function withLineNumbers(contents: string, file: string, palette: Theme): string {
  const lines = contents.replace(/\n$/, '').split('\n');
  const gutter = String(lines.length).length;
  const isCode = HIGHLIGHTED.has(path.extname(file).toLowerCase());
  const asGutter = palette.painter('LineNr');

  return lines
    .map((line, index) => {
      const number = `${String(index + 1).padStart(gutter)} |`;
      const content = isCode ? highlight(line, palette) : line;

      return `${asGutter(number)} ${content}`;
    })
    .join('\n');
}
