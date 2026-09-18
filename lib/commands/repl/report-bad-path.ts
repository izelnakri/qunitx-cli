import { red } from '../../utils/color.ts';
import type * as Files from '../../repl/files.ts';
import type { ReplContext } from './command.ts';

/**
 * Says why a typed path did not open, and puts the part that WAS real back on the prompt.
 *
 * One function because it was always two calls in a row, byte for byte, in all three commands that
 * do this — `.cat`, `.tree` and `.view`. Splitting them meant a command could say what went wrong
 * and forget to help, which is a bug nobody would see in review.
 *
 * The prompt is refilled so the next attempt costs a few keystrokes rather than the whole path:
 * `.cat lib/rep` that missed comes back as `.cat lib/` to carry on from, and TAB and the ghost take
 * it from there. Nothing is refilled on a pipe, which has no line to put it on, and nothing for a
 * path that exists but cannot be read — that one is not a typo.
 *
 * ```ts
 * import { reportBadPath } from './report-bad-path.ts';
 *
 * import type { ReplContext } from './command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   reportBadPath(repl, 'cat', 'lib/nope.ts', { kind: 'missing', prefill: 'lib/' });
 *   // logs `no such file: lib/nope.ts — lib/ exists`, then types `.cat lib/`
 * }
 * ```
 */
export function reportBadPath(
  repl: ReplContext,
  command: string,
  typed: string,
  found: Exclude<Files.Resolution, { kind: 'file' }>,
): void {
  repl.log(red(whyItFailed(found, typed)));
  if (found.kind === 'unreadable' || !repl.interactive) return;

  repl.server.write(`.${command} ${found.prefill}`);
}

/**
 * The one line, in the words that particular failure earns.
 *
 * Takes the resolution rather than the path, because `Files.resolve` already worked out WHICH of
 * the three ways it failed — a caller that re-derived that would ask the filesystem twice.
 *
 *   directory   `lib is a directory`
 *   missing     `no such file: lib/nope.ts — lib/ exists`, or without the tail where nothing does
 *   unreadable  `cannot read lib/a.ts: EACCES …`, which is the one that is not a typo
 */
function whyItFailed(found: Exclude<Files.Resolution, { kind: 'file' }>, typed: string): string {
  if (found.kind === 'directory') return `${typed} is a directory`;
  if (found.kind === 'missing') {
    return found.prefill === ''
      ? `no such file: ${typed}`
      : `no such file: ${typed} — ${found.prefill} exists`;
  }

  return `cannot read ${typed}: ${found.detail}`;
}
