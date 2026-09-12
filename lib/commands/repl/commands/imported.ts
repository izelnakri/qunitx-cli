import { paint } from '../../../repl/columns.ts';
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
 * importedCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'List what each preloaded file put in scope',
  main: async (repl) => {
    const files = await repl.session.imported();
    repl.write(
      files.length === 0
        ? 'Nothing preloaded\n'
        : `${files
            .map(({ file, names }) => {
              const painted = names
                .map(({ name, capture }) => paint(name, repl.palette.style(capture)))
                .join(', ');

              return `${paint(file, repl.palette.style('LineNr'))}: ${painted}`;
            })
            .join('\n')}\n`,
    );
    repl.prompt();
  },
};
