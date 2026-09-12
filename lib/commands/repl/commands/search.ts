import path from 'node:path';
import * as Search from '../../search.ts';
import { paint } from '../../../repl/columns.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.search` — which tests match, without running them.
 *
 * The same scan `qunitx search` runs, against the suite this session was opened on, so "which test
 * was that" is a question the prompt can answer without leaving it.
 *
 * ```ts
 * import { command as searchCommand } from './search.ts';
 *
 * searchCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Find tests whose name matches — `.search login`',
  main: async (repl, argument) => {
    const found = await Search.scan({ ...repl.config, search: argument.trim() || true });
    repl.write(
      found.matches.length === 0
        ? `No tests match — ${found.total} in ${found.files} file(s)\n`
        : `${found.matches
            .map(({ fullName, name, modules, file, line }) => {
              // `fullName` reads `": a test"` for one declared outside a module, because it is
              // built to be matched against rather than read.
              const said = modules.length === 0 ? name : fullName;
              const where = `${path.relative(repl.cwd, file)}:${line}`;

              return `${paint(where, repl.palette.style('LineNr'))}  ${said}`;
            })
            .join('\n')}\n`,
    );
    repl.prompt();
  },
};
