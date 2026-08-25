import * as Files from '../../repl/files.ts';
import type { Theme } from '../../repl/theme.ts';

/**
 * A directory drawn, with the tally `tree` prints under one — and with whatever the cap left out.
 *
 * Said outright rather than trimmed in silence: a listing that stops without saying so reads as
 * the whole answer, and the way to get the rest is the flag it names.
 */
export function showTree(typed: string, cwd: string, palette: Theme, depth: number): string {
  const { listing, counted, omitted } = Files.tree(typed, cwd, palette, depth);
  const tally = `${counted.directories} directories, ${counted.files} files`;
  const cut = omitted === 0 ? '' : ` — ${omitted} more not shown, \`-L\` to narrow`;

  return `${listing}\n\n${tally}${cut}\n`;
}

/** Why a path did not open, in one line. */
export function pathProblem(
  found: Exclude<Files.Resolution, { kind: 'file' }>,
  target: string,
): string {
  if (found.kind === 'directory') return `${target} is a directory`;
  if (found.kind === 'missing') {
    return found.retype === ''
      ? `no such file: ${target}`
      : `no such file: ${target} — ${found.retype} exists`;
  }

  return `cannot read ${target}: ${found.detail}`;
}
