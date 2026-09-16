import * as Files from '../../../repl/files.ts';
import { drawTree, pathError, prefillPrompt } from '../paths.ts';
import { describeValue } from '../describe.ts';
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
    const { file, depth } = Files.pathAndDepth(argument.trim());
    if (argument.trim() === '') {
      repl.log('Usage: .view <file>');

      return;
    }

    const found = Files.resolve(file, repl.cwd);
    if (found.kind === 'file') {
      repl.log(`${Files.numbered(found.contents, file, repl.palette)}`);

      return;
    }
    if (found.kind === 'directory') {
      repl.log(drawTree(file, repl.cwd, repl.palette, depth));

      return;
    }

    const said = await describeValue(repl.session, file, repl.cwd, repl.palette, { body: true });
    if (said !== null) {
      repl.log(`${said}`);

      return;
    }
    repl.log(red(`${pathError(found, file)}`));
    prefillPrompt('view', found, repl);
  },
};
