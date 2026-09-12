import { ESCAPE } from '../../repl/columns.ts';
import type * as Repl from '../../repl/session.ts';

/**
 * Clears the visible screen and leaves the scrollback alone.
 *
 * `[2J` erases what is on screen; `[3J` would erase what has scrolled off it, which is the
 * difference between clearing a terminal and losing the last hour of it. Only the first is sent,
 * which is why scrolling still works afterwards — and which is what readline already does for
 * Ctrl-L, so that key needs nothing from us.
 *
 * ```ts
 * import { clearScreen } from './output.ts';
 *
 * clearScreen().includes('[3J'); // false — the scrollback is not ours to throw away
 * ```
 */
export function clearScreen(): string {
  return `${ESCAPE}[H${ESCAPE}[2J`;
}

/**
 * A failure, in the words its kind earns.
 *
 * `Uncaught` is what a browser console says about an exception, and belongs only to one the page
 * actually threw. "That file will not bundle" is this REPL answering, and prefixing it would claim
 * the page had refused something it was never shown.
 *
 * ```ts
 * import { failure } from './output.ts';
 *
 * failure({ output: 'boom', failed: true, thrown: true, incomplete: false, tests: [] });
 * // 'Uncaught boom'
 * failure({ output: 'will not bundle', failed: true, incomplete: false, tests: [] });
 * // 'will not bundle' — nothing threw, so nothing is called uncaught
 * ```
 */
export function failure(result: Repl.ReplResult): string {
  return result.thrown ? `Uncaught ${result.output}` : result.output;
}
