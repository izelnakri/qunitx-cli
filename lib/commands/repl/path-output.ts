import * as Files from '../../repl/files.ts';
import type { ReplContext } from './command.ts';

// What `.cat`, `.tree`, `.ls` and `.view` PRINT once `Files.resolve` has said what a typed path
// turned out to be. Not path arithmetic — that is lib/repl/files.ts, which this is the terminal
// half of.

/**
 * A directory drawn, plus the tally `tree` prints under one, plus whatever the cap left out.
 *
 * `Files.tree` does the walking and the colouring; the tally and the "there was more" line are
 * what this adds, and they are why it exists. Said outright rather than trimmed in silence: a
 * listing that stops without saying so reads as the whole answer, and the way to get the rest is
 * the flag it names.
 *
 * ```ts
 * import { treeWithTally } from './path-output.ts';
 *
 * import type { ReplContext } from './command.ts';
 *
 * // Defined, not invoked: it reads the filesystem and the terminal's colours.
 * function example(repl: ReplContext) {
 *   return treeWithTally(repl, 'lib', 1); // includes '3 directories, 12 files'
 * }
 * ```
 */
export function treeWithTally(repl: ReplContext, typed: string, depth: number): string {
  const { listing, counted, omitted } = Files.tree(typed, repl.cwd, repl.palette, depth);
  const tally = `${counted.directories} directories, ${counted.files} files`;
  const cut = omitted === 0 ? '' : ` — ${omitted} more not shown, \`-L\` to narrow`;

  return `${listing}\n\n${tally}${cut}`;
}

/**
 * One line saying why a typed path did not open, in the words its particular failure earns.
 *
 * Takes the resolution rather than the path, because `Files.resolve` already worked out WHICH of
 * the three ways it failed — and a caller that re-derived that from the path would be asking the
 * filesystem the same question twice.
 *
 * ```ts
 * import { pathErrorLine } from './path-output.ts';
 *
 * pathErrorLine({ kind: 'directory', prefill: 'lib/' }, 'lib'); // 'lib is a directory'
 * pathErrorLine({ kind: 'missing', prefill: '' }, 'nope.ts'); // 'no such file: nope.ts'
 * ```
 */
export function pathErrorLine(
  found: Exclude<Files.Resolution, { kind: 'file' }>,
  typed: string,
): string {
  if (found.kind === 'directory') return `${typed} is a directory`;
  if (found.kind === 'missing') {
    return found.prefill === ''
      ? `no such file: ${typed}`
      : `no such file: ${typed} — ${found.prefill} exists`;
  }

  return `cannot read ${typed}: ${found.detail}`;
}

/**
 * Types the part of the path that WAS real back onto the prompt, so the next attempt costs a few
 * keystrokes rather than the whole path again.
 *
 * `.cat lib/rep` that missed comes back as `.cat lib/` to carry on from; TAB and the ghost take it
 * from there. Nothing to put back on a pipe, which has no line to put it on, and nothing for a
 * path that exists but cannot be read — that one is not a typo.
 *
 * ```ts
 * import { prefillPrompt } from './path-output.ts';
 *
 * import type { ReplContext } from './command.ts';
 *
 * // Defined, not invoked: it types into a live prompt.
 * function example(repl: ReplContext) {
 *   prefillPrompt(repl, 'cat', { kind: 'missing', prefill: 'lib/' }); // writes `.cat lib/`
 * }
 * ```
 */
export function prefillPrompt(
  repl: ReplContext,
  command: string,
  found: Exclude<Files.Resolution, { kind: 'file' }>,
): void {
  if (found.kind === 'unreadable' || !repl.interactive) return;
  repl.server.write(`.${command} ${found.prefill}`);
}
