import path from 'node:path';
import { noSuchValueLine } from '../no-such-value-line.ts';
import { highlight } from '../../../repl/highlight.ts';
import { readIfThere } from '../editor.ts';
import { signature } from '../../../repl/docs.ts';
import { red } from '../../../utils/color.ts';
import type { ReplCommand } from '../command.ts';
import type { ReplSession } from '../../../repl/session.ts';
import type { Theme } from '../../../repl/theme.ts';

/**
 * `.type` — what TypeScript would call it.
 *
 * The written type where there is one, and the value's own shape where there is not: a function in
 * a file you can read HAS a type, spelled out by whoever wrote it, and inventing a structural one
 * for it would be answering a question nobody asked.
 *
 * ```ts
 * import { command as typeCommand } from './type.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return typeCommand.main(repl, 'double'); // the written signature, or the value's shape
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Say what type a value is — the signature where one is written, its shape otherwise',
  async main(repl, argument) {
    const said = await describeType(repl.session, argument, repl.cwd, repl.palette);
    repl.log(said === null ? red(noSuchValueLine(argument, 'type')) : said);
  },
};

/**
 * What a value's type is, painted — or `null` where there is no such value to have one.
 *
 * The signature from the file first, because a written type is the real answer and a structural one
 * worked out from a function object could only ever be a worse guess at it. Everything else the
 * page describes from the value, which for everything else is all there is.
 *
 * Private, and here rather than in a module of its own: `.type` is its only caller, and a file
 * you open once to read one function is a file that did not need to exist.
 *
 * Deliberately NOT named `typeOf`:
 * that word belongs to the two layers under this one — `session.typeOf(expression)`, which asks
 * the page, and `typeOfValue(value)`, which is what the page then runs. Three `typeOf`s in one
 * call chain is a stack trace nobody can read.
 *
 */
async function describeType(
  session: ReplSession,
  argument: string,
  cwd: string,
  palette: Theme,
): Promise<string | null> {
  const asked = argument.trim();
  if (asked === '') return null;

  const at = await session.declaredAt(asked);
  const source = at === null ? null : readIfThere(path.resolve(cwd, at.file));
  const written = source === null || at === null ? '' : signature(source, at.line);
  if (written !== '') return highlight(written, palette);

  const inferred = await session.typeOf(asked);

  return inferred === '' ? null : highlight(inferred, palette);
}
