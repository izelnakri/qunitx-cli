import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

import { blockAt, commentAbove, renderDoc, signature } from '../../repl/docs.ts';
import { highlight } from '../../repl/highlight.ts';
import { paint } from '../../repl/columns.ts';
import { tryReadFile } from './editor.ts';
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
 * import { describeValue } from './values.ts';
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
  const source = at === null ? null : tryReadFile(path.resolve(cwd, at.file));
  if (at === null || source === null) return await asWritten(session, asked, palette, depth);

  // Where, then what was said, then the code — reading order, and the order they were written in.
  // The body opens with the signature, so a `.view` that printed both would print it twice.
  const parts = [
    paint(`${at.file}:${at.line}`, palette.style('LineNr')),
    renderDoc(commentAbove(source, at.line), palette),
    highlight(depth.body ? blockAt(source, at.line) : signature(source, at.line), palette),
  ];

  return parts.filter((part) => part !== '').join('\n');
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

  return where === null ? rendered : `${paint(where, palette.style('LineNr'))}\n${rendered}`;
}

/**
 * What a value's type is, painted — or `null` where there is no such value to have one.
 *
 * The signature from the file first, because a written type is the real answer and a structural one
 * worked out from a function object could only ever be a worse guess at it. Everything else the
 * page describes from the value, which for everything else is all there is.
 *
 * ```ts
 * import { typeOfValue } from './values.ts';
 *
 * import type { ReplSession } from '../../repl/session.ts';
 * import type { Theme } from '../../repl/theme.ts';
 *
 * // Defined, not invoked: it asks a live page what something is.
 * function example(session: ReplSession, palette: Theme) {
 *   return typeOfValue(session, 'answer', process.cwd(), palette); // 'number', or null
 * }
 * ```
 */
export async function typeOfValue(
  session: ReplSession,
  argument: string,
  cwd: string,
  palette: Theme,
): Promise<string | null> {
  const asked = argument.trim();
  if (asked === '') return null;

  const at = await session.declaredAt(asked);
  const source = at === null ? null : tryReadFile(path.resolve(cwd, at.file));
  const written = source === null || at === null ? '' : signature(source, at.line);
  if (written !== '') return highlight(written, palette);

  const inferred = await session.typeOf(asked);

  return inferred === '' ? null : highlight(inferred, palette);
}

/**
 * Puts a value on the clipboard and says what went, or `null` where there was nothing to send.
 *
 * A function goes as the code that defines it, because that is the thing anybody copying a
 * function wants; everything else goes as the value the prompt would have printed.
 *
 * ```ts
 * import { copyValue } from './values.ts';
 *
 * import type { ReplSession } from '../../repl/session.ts';
 *
 * // Defined, not invoked: it puts something on a real clipboard.
 * function example(session: ReplSession) {
 *   return copyValue(session, 'double', process.cwd()); // 'copied 3 line(s)', or null
 * }
 * ```
 */
export async function copyValue(
  session: ReplSession,
  argument: string,
  cwd: string,
): Promise<string | null> {
  const asked = argument.trim();
  if (asked === '') return null;

  const at = await session.declaredAt(asked);
  const source = at === null ? null : tryReadFile(path.resolve(cwd, at.file));
  const text =
    at !== null && source !== null
      ? blockAt(source, at.line)
      : await session.preview(asked).then(plainText);
  if (text === '') return null;

  return (await toClipboard(text)) ? `copied ${text.split('\n').length} line(s)\n` : null;
}

/** Rendered values arrive painted; a clipboard wants the characters and none of the colour. */
function plainText(rendered: string): string {
  const escape = String.fromCharCode(27);

  return rendered
    .split(escape)
    .map((part, index) => (index === 0 ? part : part.slice(part.indexOf('m') + 1)))
    .join('');
}

/**
 * The command this platform copies with, and the arguments it takes.
 *
 * Every desktop has one and no two agree on its name, so the answer is a list and the first one
 * that runs wins. `null` where the platform is not one of the three.
 *
 * ```ts
 * import { clipboardCommands } from './values.ts';
 *
 * clipboardCommands('darwin'); // [['pbcopy', []]]
 * clipboardCommands('sunos'); // [] — nothing here knows how
 * ```
 */
export function clipboardCommands(platform: string): Array<[string, string[]]> {
  if (platform === 'darwin') return [['pbcopy', []]];
  if (platform === 'win32') return [['clip', []]];
  if (platform !== 'linux') return [];

  // Wayland first, then the two X selections owners, because a desktop may have any of them.
  return [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ];
}

/** True once something took the text. Tried in order, because a desktop has whichever it has. */
async function toClipboard(text: string): Promise<boolean> {
  for (const [command, args] of clipboardCommands(process.platform)) {
    const sent = await new Promise<boolean>((resolve) => {
      const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      child.stdin?.end(text);
    });
    if (sent) return true;
  }

  return false;
}

/**
 * Why there is nothing to show, in the two ways there can be nothing.
 *
 * ```ts
 * import { nowhere } from './values.ts';
 *
 * nowhere('', 'doc'); // 'Usage: .doc <value>'
 * nowhere('helper', 'doc').includes('not a function'); // true — the other way there is nothing
 * ```
 */
export function nowhere(argument: string, command: string): string {
  const asked = argument.trim();

  return asked === ''
    ? `Usage: .${command} <value>`
    : `nothing known about ${asked} — no such name in this session`;
}
