import pkg from '../../../../package.json' with { type: 'json' };
import type { ReplCommand } from '../command.ts';

/** `.version` — which qunitx this prompt is, for a bug report that names one.
 *
 * ```ts
 * import { command as versionCommand } from './version.ts';
 *
 * versionCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Print the qunitx version this session is running',
  main: (repl) => {
    repl.write(`${pkg.version}\n`);
    repl.prompt();
  },
};
