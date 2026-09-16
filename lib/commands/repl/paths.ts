import * as Files from '../../repl/files.ts';
import type { ReplContext } from './command.ts';
import type { Theme } from '../../repl/theme.ts';

/**
 * A directory drawn, with the tally `tree` prints under one — and with whatever the cap left out.
 *
 * Said outright rather than trimmed in silence: a listing that stops without saying so reads as
 * the whole answer, and the way to get the rest is the flag it names.
 *
 * ```ts
 * import { drawTree } from './paths.ts';
 *
 * const plain = { style: () => '' };
 * drawTree('lib', process.cwd(), plain, 1).includes('directories,'); // true — the tally is part of it
 * ```
 */
export function drawTree(typed: string, cwd: string, palette: Theme, depth: number): string {
  const { listing, counted, omitted } = Files.tree(typed, cwd, palette, depth);
  const tally = `${counted.directories} directories, ${counted.files} files`;
  const cut = omitted === 0 ? '' : ` — ${omitted} more not shown, \`-L\` to narrow`;

  return `${listing}\n\n${tally}${cut}`;
}

/**
 * Why a path did not open, in one line.
 *
 * ```ts
 * import { pathError } from './paths.ts';
 *
 * pathError({ kind: 'directory', prefill: 'lib/' }, 'lib'); // 'lib is a directory'
 * pathError({ kind: 'missing', prefill: '' }, 'nope.ts'); // 'no such file: nope.ts'
 * ```
 */
export function pathError(
  found: Exclude<Files.Resolution, { kind: 'file' }>,
  target: string,
): string {
  if (found.kind === 'directory') return `${target} is a directory`;
  if (found.kind === 'missing') {
    return found.prefill === ''
      ? `no such file: ${target}`
      : `no such file: ${target} — ${found.prefill} exists`;
  }

  return `cannot read ${target}: ${found.detail}`;
}

/**
 * Puts the part of the path that WAS real back on the prompt, so the next attempt is a few
 * keystrokes rather than the whole path again — `.cat lib/rep` becomes `.cat lib/` to carry on
 * from. TAB and the ghost take it from there.
 *
 * Nothing to put back on a pipe, which has no line to put it on, and nothing for a path that exists
 * but cannot be read — that one is not a typo.
 *
 * ```ts
 * import { prefillPrompt } from './paths.ts';
 *
 * import type { ReplContext } from './command.ts';
 *
 * // Defined, not invoked: it types into a live prompt.
 * function example(repl: ReplContext) {
 *   prefillPrompt('cat', { kind: 'missing', prefill: 'lib/' }, repl); // writes `.cat lib/`
 * }
 * ```
 */
export function prefillPrompt(
  name: string,
  found: Exclude<Files.Resolution, { kind: 'file' }>,
  repl: ReplContext,
): void {
  if (found.kind === 'unreadable' || !repl.interactive) return;
  repl.server.write(`.${name} ${found.prefill}`);
}
