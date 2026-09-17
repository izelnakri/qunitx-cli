import path from 'node:path';
import { blockAt, commentAbove, renderDoc, signature } from '../../repl/docs.ts';
import { readIfThere } from './editor.ts';
import { highlight } from '../../repl/highlight.ts';
import { inStyle } from '../../repl/terminal.ts';
import type { ReplSession } from '../../repl/session.ts';
import type { Theme } from '../../repl/theme.ts';

/** How far into a value `.view` renders — deep enough that what is in it is what is printed. */
const WHOLE_VALUE = 8;

/** How much of a value to show: what it is, or what it is and how it is written. */
interface Depth {
  /** Include the whole declaration, not only its signature and comment. */
  body: boolean;
}

/**
 * What is known about a value, ready to print — or `null` where nothing is.
 *
 * In the order a file has them: where it is, what was written above it, then the thing itself. A
 * value with no comment still has the other two, which is the difference between "here it is" and
 * the "nothing written about it" this used to answer.
 *
 * Only a function has a declaration V8 can point at. Everything else — an imported namespace, a
 * string, an object — still came from somewhere this session watched it arrive from, and is still
 * worth printing, so what is known about those is where they came in and what they are.
 *
 * ```ts
 * import { describeValue } from './describe.ts';
 *
 * import type { ReplSession } from '../../repl/session.ts';
 * import type { Theme } from '../../repl/theme.ts';
 *
 * // Defined, not invoked: it asks a live page where something came from.
 * function example(session: ReplSession, palette: Theme) {
 *   return describeValue(session, 'helper', process.cwd(), palette, { body: false });
 * }
 * ```
 */
export async function describeValue(
  session: ReplSession,
  argument: string,
  cwd: string,
  palette: Theme,
  depth: Depth,
): Promise<string | null> {
  const asked = argument.trim();
  const at = await session.declaredAt(asked);
  const source = at === null ? null : readIfThere(path.resolve(cwd, at.file));
  if (at === null || source === null) return await asWritten(session, asked, palette, depth);

  // Where, then what was said, then the code — reading order, and the order they were written in.
  // The body opens with the signature, so a `.view` that printed both would print it twice.
  const parts = [
    inStyle(`${at.file}:${at.line}`, palette.style('LineNr')),
    renderDoc(commentAbove(source, at.line), palette),
    highlight(depth.body ? blockAt(source, at.line) : signature(source, at.line), palette),
  ];

  return parts.filter((part) => part !== '').join('\n');
}

/**
 * What a value's type is, painted — or `null` where there is no such value to have one.
 *
 * The signature from the file first, because a written type is the real answer and a structural one
 * worked out from a function object could only ever be a worse guess at it. Everything else the
 * page describes from the value, which for everything else is all there is.
 *
 * Named beside {@link describeValue}, which it is the parallel of, and deliberately NOT `typeOf`:
 * that word belongs to the two layers under this one — `session.typeOf(expression)`, which asks
 * the page, and `typeOfValue(value)`, which is what the page then runs. Three `typeOf`s in one
 * call chain is a stack trace nobody can read.
 *
 * ```ts
 * import { describeType } from './describe.ts';
 *
 * import type { ReplSession } from '../../repl/session.ts';
 * import type { Theme } from '../../repl/theme.ts';
 *
 * // Defined, not invoked: it asks a live page what something is.
 * function example(session: ReplSession, palette: Theme) {
 *   return describeType(session, 'answer', process.cwd(), palette); // 'number', or null
 * }
 * ```
 */
export async function describeType(
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

/**
 * Why there is nothing to show, in the two ways there can be nothing.
 *
 * ```ts
 * import { noSuchValue } from './describe.ts';
 *
 * noSuchValue('', 'doc'); // 'Usage: .doc <value>'
 * noSuchValue('helper', 'doc').includes('no such name'); // true — the other way there is nothing
 * ```
 */
export function noSuchValue(argument: string, command: string): string {
  const asked = argument.trim();

  return asked === ''
    ? `Usage: .${command} <value>`
    : `nothing known about ${asked} — no such name in this session`;
}

/**
 * What is known about a value with no declaration to point at: where it came into this session, and
 * what it is — rendered in the page, by the renderer the prompt prints with.
 *
 * `null` for a name that is not there at all, which is the one case where "nothing known" is the
 * true answer rather than the lazy one.
 */
async function asWritten(
  session: ReplSession,
  asked: string,
  palette: Theme,
  depth: Depth,
): Promise<string | null> {
  // `.view` is the whole value and `.doc` is what a prompt has room for, which is the same
  // difference as between a function's body and its signature.
  const rendered = await session.preview(asked, depth.body ? WHOLE_VALUE : undefined);
  if (rendered === '') return null;
  const where = session.whereFrom(asked);

  return where === null ? rendered : `${inStyle(where, palette.style('LineNr'))}\n${rendered}`;
}
