import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { blue, red } from '../../utils/color.ts';
import { blockAt, commentAbove, renderDoc, signature } from '../../repl/docs.ts';
import { highlight } from '../../repl/highlight.ts';
import { paint } from '../../repl/columns.ts';
import { tryReadFile } from './editor.ts';
import type { REPLServer } from 'node:repl';
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
 * Every command about a value rather than a file: what came from where, what it is, and how to get
 * at it.
 *
 * ```ts
 * import { defineValues } from './values.ts';
 *
 * import type { REPLServer } from 'node:repl';
 * import type { ReplSession } from '../../repl/session.ts';
 * import type { Theme } from '../../repl/theme.ts';
 *
 * // Defined, not invoked: it needs a live prompt and a live page.
 * function example(server: REPLServer, session: ReplSession, palette: Theme) {
 *   defineValues(server, session, palette, process.cwd());
 * }
 * ```
 */
export function defineValues(
  server: REPLServer,
  session: ReplSession,
  palette: Theme,
  cwd: string,
): void {
  // What the preloaded files put in scope. The names alone say nothing about what they are, so
  // each is painted the colour this REPL paints that kind of value — a hint at the type without
  // printing every value to get it.
  server.defineCommand('imported', {
    help: 'List what each preloaded file put in scope',
    action() {
      this.clearBufferedCommand();
      void session.imported().then((files) => {
        this.output.write(
          files.length === 0
            ? 'Nothing preloaded\n'
            : `${files
                .map(({ file, names }) => {
                  const painted = names
                    .map(({ name, capture }) => paint(name, palette.style(capture)))
                    .join(', ');

                  return `${paint(file, palette.style('LineNr'))}: ${painted}`;
                })
                .join('\n')}\n`,
        );
        this.displayPrompt();
      });
    },
  });
  // `.import` reads as the language does, `.load` is the name `node:repl` already had for putting
  // a file into a session — and this REPL's answer to it, since a browser cannot replay lines of
  // Node. One command under both names, because a hand that has typed one expects the other.
  // Dropped first because `node:repl` registered its own `.load` at start-up, and the help reads
  // the order the names were defined in — leaving it there made `.import` an alias of `.load`
  // rather than the other way round.
  delete (server.commands as Record<string, unknown>).load;
  for (const name of ['import', 'load']) {
    server.defineCommand(name, {
      help: 'Bring a file into the page — `.import lib/a.ts` puts it in scope as `A`',
      action(argument: string) {
        this.clearBufferedCommand();
        const [file, as] = argument.trim().split(/\s+/);
        if (file === undefined || file === '') {
          this.output.write(`Usage: .${name} <file> [name]\n`);

          return void this.displayPrompt();
        }
        void session.importFile(file, as).then((brought) => {
          if (typeof brought === 'string') this.output.write(red(`${brought}\n`));
          else {
            const exported = brought.names.filter((known) => known !== brought.name);
            const also = exported.length === 0 ? '' : `, and ${exported.join(', ')}`;
            this.output.write(blue(`${brought.name}${also}\n`));
          }
          this.displayPrompt();
        });
      },
    });
  }
  // `.doc` for what it is, `.explain` for what you want from it, `.d` for the hand.
  for (const name of ['doc', 'explain', 'd']) {
    server.defineCommand(name, {
      help: 'Show a value’s signature, where it is written, and the comment above it',
      action(argument: string) {
        this.clearBufferedCommand();
        void describeValue(session, argument, cwd, palette, { body: false }).then((said) => {
          this.output.write(said === null ? red(`${nowhere(argument, 'doc')}\n`) : `${said}\n`);
          this.displayPrompt();
        });
      },
    });
  }
  server.defineCommand('copy', {
    help: 'Copy a value to the clipboard — a function goes as the code that defines it',
    action(argument: string) {
      this.clearBufferedCommand();
      void copyValue(session, argument, cwd).then((copied) => {
        this.output.write(copied === null ? red(`${nowhere(argument, 'copy')}\n`) : blue(copied));
        this.displayPrompt();
      });
    },
  });
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
 * Puts a value on the clipboard and says what went, or `null` where there was nothing to send.
 *
 * A function goes as the code that defines it, because that is the thing anybody copying a
 * function wants; everything else goes as the value the prompt would have printed.
 */
async function copyValue(
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
