import path from 'node:path';
import { blockAt, commentAbove, renderDoc, signature } from '../../repl/docs.ts';
import { readIfThere } from './editor.ts';
import { highlight } from '../../repl/highlight.ts';
import { inStyle } from '../../repl/terminal.ts';
import type { ReplContext } from './command.ts';
import type { ReplSession } from '../../repl/session.ts';
import type { Theme } from '../../repl/theme.ts';

/** How far into a value `.view` renders — deep enough that what is in it is what is printed. */
const WHOLE_VALUE = 8;

/**
 * How much to show — the one thing that differs between `.doc` and `.view`.
 *
 * A word rather than `{ body: boolean }`, because the caller site now says which it wants:
 * `valueDetails(repl, argument, 'brief')`. For a function `brief` is its signature and `full` is
 * its whole declaration; for anything else `brief` is the line-long summary a prompt has room for
 * and `full` is the value rendered all the way down.
 */
export type Detail = 'brief' | 'full';

/**
 * Everything this session can say about a name, ready to print — or `null` where there is nothing.
 *
 * In the order a file has them: where it is, what was written above it, then the thing itself. A
 * value with no comment still has the other two, which is the difference between "here it is" and
 * the "nothing written about it" this used to answer.
 *
 * Only a function has a declaration V8 can point at. Everything else — an imported namespace, a
 * string, an object — still came from somewhere this session watched it arrive from, and is still
 * worth printing, so what is known about those is where they came in and what they are.
 *
 * Takes `repl` rather than a session, a cwd and a palette spread across five positionals — all
 * three come off it, and every caller was passing `repl.session, argument, repl.cwd, repl.palette`.
 *
 * ```ts
 * import { valueDetails } from './value-details.ts';
 *
 * import type { ReplContext } from './command.ts';
 *
 * // Defined, not invoked: it asks a live page where something came from.
 * function example(repl: ReplContext) {
 *   return valueDetails(repl, 'helper', 'brief'); // `.doc`'s half; 'full' is `.view`'s
 * }
 * ```
 */
export async function valueDetails(
  repl: ReplContext,
  argument: string,
  detail: Detail,
): Promise<string | null> {
  const { session, cwd, palette } = repl;
  const asked = argument.trim();
  const at = await session.declaredAt(asked);
  const source = at === null ? null : readIfThere(path.resolve(cwd, at.file));
  if (at === null || source === null)
    return await renderedByThePage(session, asked, palette, detail);

  // Where, then what was said, then the code — reading order, and the order they were written in.
  // The body opens with the signature, so a `.view` that printed both would print it twice.
  const parts = [
    inStyle(`${at.file}:${at.line}`, palette.style('LineNr')),
    renderDoc(commentAbove(source, at.line), palette),
    highlight(detail === 'full' ? blockAt(source, at.line) : signature(source, at.line), palette),
  ];

  return parts.filter((part) => part !== '').join('\n');
}

/**
 * The fallback for a value with no declaration to point at — a string, a number, an imported
 * namespace. Where it came into this session, and what it is, rendered IN THE PAGE by the same
 * renderer the prompt prints values with.
 *
 * `null` for a name that is not there at all, which is the one case where "nothing known" is the
 * true answer rather than the lazy one.
 */
async function renderedByThePage(
  session: ReplSession,
  asked: string,
  palette: Theme,
  detail: Detail,
): Promise<string | null> {
  // `.view` is the whole value and `.doc` is what a prompt has room for, which is the same
  // difference as between a function's body and its signature.
  const rendered = await session.preview(asked, detail === 'full' ? WHOLE_VALUE : undefined);
  if (rendered === '') return null;
  const where = session.whereFrom(asked);

  return where === null ? rendered : `${inStyle(where, palette.style('LineNr'))}\n${rendered}`;
}
