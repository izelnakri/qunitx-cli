import process from 'node:process';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { blockAt } from '../../repl/docs.ts';
import { readIfThere } from './editor.ts';
import type { ReplSession } from '../../repl/session.ts';

/**
 * Puts a value on the clipboard and says what went, or `null` where there was nothing to send.
 *
 * A function goes as the code that defines it, because that is the thing anybody copying a
 * function wants; everything else goes as the value the prompt would have printed.
 *
 * ```ts
 * import { copyValue } from './clipboard.ts';
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
  const source = at === null ? null : readIfThere(path.resolve(cwd, at.file));
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
 * import { clipboardCommands } from './clipboard.ts';
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
