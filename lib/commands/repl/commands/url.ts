import type { ReplCommand } from '../command.ts';

/** `.url` — where the page is served, so you can open it yourself and watch.
 *
 * ```ts
 * import { command as urlCommand } from './url.ts';
 *
 * urlCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Print the URL this session is served on (open it to watch the page)',
  main: (repl) => {
    repl.write(`${repl.session.url}\n`);
    repl.prompt();
  },
};
