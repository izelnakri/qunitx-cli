import path from 'node:path';
import { blockAt, commentAbove, renderDoc, signature } from '../../repl/docs.ts';
import { readIfThere } from './editor.ts';
import { highlight } from '../../repl/highlight.ts';
import type { ReplContext } from './command.ts';
import type { ReplSession } from '../../repl/session.ts';
import type { Theme } from '../../repl/theme.ts';

// Two questions about a value, one answer apiece. `.doc` asks the first, `.view` the second, and
// they share everything except how much comes back — which is why this is one file and two
// exported functions rather than one function with a word to pass it.
//
// Both hand back the text to print and `null` where there is no such name. The caller does the
// writing, because the caller is the one that knows where the answer goes — `.doc` prints it,
// `.view` prints it or falls through to treating the same name as a path.

/** How far into a value `.view` renders — deep enough that what is in it is what is printed. */
const WHOLE_VALUE = 8;

/**
 * Enough to recognise a value by: where it is written, what was written above it, and its
 * signature. `null` where this session knows nothing by that name. What `.doc` prints.
 *
 * In the order a file has them — where it is, what was said about it, then the thing itself. A
 * value with no comment still has the other two, which is the difference between "here it is" and
 * the "nothing written about it" this used to answer.
 *
 * ```ts
 * import { summarizeValue } from './value-details.ts';
 *
 * import type { ReplContext } from './command.ts';
 *
 * // Defined, not invoked: it asks a live page where something came from.
 * function example(repl: ReplContext) {
 *   return summarizeValue(repl, 'double');
 *   // 'test/fixtures/repl-helpers.ts:15\nDoubles a number…\nexport function double(…)'
 * }
 * ```
 */
export function summarizeValue(repl: ReplContext, argument: string): Promise<string | null> {
  return describe(repl, argument, false);
}

/**
 * The whole of a value: a function's entire declaration, body included, or anything else rendered
 * all the way down rather than summarised to a line. `null` where there is no such name. What
 * `.view` prints.
 *
 * The body opens with the signature, so this does NOT also print the signature separately — a
 * `.view` that did would print it twice.
 *
 * ```ts
 * import { printValueDetails } from './value-details.ts';
 *
 * import type { ReplContext } from './command.ts';
 *
 * // Defined, not invoked: it asks a live page where something came from.
 * function example(repl: ReplContext) {
 *   return printValueDetails(repl, 'double'); // the same, with the function's body in place of its head
 * }
 * ```
 *
 * `null` is the interesting return: `.view` takes it as "not a value after all" and goes on to try
 * the same name as a path, which is how one command answers three kinds of question.
 */
export function printValueDetails(repl: ReplContext, argument: string): Promise<string | null> {
  return describe(repl, argument, true);
}

/**
 * The shared half. `body` is the only thing the two public names differ by, and it stays in here
 * as a boolean because nothing outside this file ever has to read it — a caller picks a NAME.
 *
 * Only a function has a declaration V8 can point at. Everything else — an imported namespace, a
 * string, an object — still came from somewhere this session watched it arrive from, and is still
 * worth printing, so what is known about those is where they came in and what they are.
 */
async function describe(
  repl: ReplContext,
  argument: string,
  body: boolean,
): Promise<string | null> {
  const { session, cwd, palette } = repl;
  const asked = argument.trim();
  const at = await session.declaredAt(asked);
  const source = at === null ? null : readIfThere(path.resolve(cwd, at.file));
  if (at === null || source === null) return await renderedByThePage(session, asked, palette, body);

  // Where, then what was said, then the code — reading order, and the order they were written in.
  const parts = [
    palette.painter('LineNr')(`${at.file}:${at.line}`),
    renderDoc(commentAbove(source, at.line), palette),
    highlight(body ? blockAt(source, at.line) : signature(source, at.line), palette),
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
  body: boolean,
): Promise<string | null> {
  // The same difference one level down: `.view` is the value all the way in, `.doc` is what a
  // prompt has room for on a line.
  const rendered = await session.preview(asked, body ? WHOLE_VALUE : undefined);
  if (rendered === '') return null;
  const where = session.whereFrom(asked);

  return where === null ? rendered : `${palette.painter('LineNr')(where)}\n${rendered}`;
}
