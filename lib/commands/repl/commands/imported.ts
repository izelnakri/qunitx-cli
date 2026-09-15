import { styled } from '../../../repl/columns.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.imported` — what each file in scope put there, painted by kind.
 *
 * The names alone say nothing about what they are, so each is painted the colour this REPL paints
 * that kind of value: a hint at the type without printing every value to get it.
 *
 * ```ts
 * import { command as importedCommand } from './imported.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return importedCommand.main(repl, ''); // what each file in scope put there
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'List what each preloaded file put in scope',
  async main(repl) {
    const files = await repl.session.imported();
    repl.log(
      files.length === 0
        ? 'Nothing preloaded'
        : `${files
            .map(({ file, names }) => {
              const painted = names
                .map(({ name, capture }) => styled(name, repl.palette.style(capture)))
                .join(', ');

              return `${styled(file, repl.palette.style('LineNr'))}: ${painted}`;
            })
            .join('\n')}`,
    );
  },
};
