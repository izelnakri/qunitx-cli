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
  const at = await session.declaredAt(argument.trim());
  if (!at) return null;
  const source = tryReadFile(path.resolve(cwd, at.file));
  if (source === null) return null;

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
  // `.doc` for what it is, `.explain` for what you want from it.
  for (const name of ['doc', 'explain']) {
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
    : `nothing known about ${asked} — it was defined here, or it is not a function`;
}
