import pkg from '../../../../package.json' with { type: 'json' };
import type { ReplCommand } from '../command.ts';

/**
 * `.version` — which qunitx this prompt is, for a bug report that names one.
 *
 * ```ts
 * import { command as versionCommand } from './version.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return versionCommand.main(repl, ''); // the qunitx this prompt is
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Print the qunitx version this session is running',
  main(repl) {
    repl.log(`${pkg.version}`);
  },
};
