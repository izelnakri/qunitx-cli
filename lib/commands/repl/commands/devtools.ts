import { openExternally } from '../editor.ts';
import { blue, red } from '../../../utils/color.ts';
import type { Config as ResolvedConfig } from '../../../types.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.devtools` — Chrome's own DevTools, on the very page the prompt is driving.
 *
 * The address handed out is this session's server, not Chrome's: one port to remember, and it
 * redirects to whatever port Chrome took this time.
 *
 * ```ts
 * import { command as devtoolsCommand } from './devtools.ts';
 *
 * devtoolsCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Open Chrome DevTools on this very page — same realm, same DOM, same paused frame',
  main: async (repl) => {
    const address = repl.session.inspector;
    if (address === null) {
      repl.write(red(`${nowhereToInspect(repl.config)}\n`));

      return repl.prompt();
    }
    const failed = repl.interactive ? await openExternally(address) : null;
    repl.write(failed ?? blue(`${address}\n`));
    repl.prompt();
  },
};

/**
 * Why there is no page to inspect, in the words of whichever reason it is.
 *
 * A window has F12 and needs no address. Everything else comes down to the same thing — this
 * session is driving a browser Playwright launched, which talks over a pipe and serves no DevTools
 * — and the one place that happens by default is macOS, where nothing is pre-launched.
 */
function nowhereToInspect(config: ResolvedConfig): string {
  return config.open === true
    ? 'no address needed — press F12 in the window instead'
    : 'no debugging endpoint here, so no DevTools to open — try `--open` for a window instead';
}
