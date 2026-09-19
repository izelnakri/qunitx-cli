import path from 'node:path';
import * as Search from '../../search.ts';
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
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return searchCommand.main(repl, 'login'); // the tests whose name matches
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Find tests whose name matches — `.search login`',
  async main(repl, argument) {
    const found = await Search.scan({ ...repl.config, search: argument.trim() || true });
    repl.log(
      found.matches.length === 0
        ? `No tests match — ${found.total} in ${found.files} file(s)`
        : `${found.matches
            .map(({ fullName, name, modules, file, line }) => {
              // `fullName` reads `": a test"` for one declared outside a module, because it is
              // built to be matched against rather than read.
              const said = modules.length === 0 ? name : fullName;
              const where = `${path.relative(repl.cwd, file)}:${line}`;

              return `${repl.palette.painter('LineNr')(where)}  ${said}`;
            })
            .join('\n')}`,
    );
  },
};
