import { PassThrough } from 'node:stream';
import { ESCAPE } from '../../repl/columns.ts';

// Ctrl-K and Ctrl-J as their raw bytes, and the arrows readline already understands.
const CTRL_K = 0x0b;
const CTRL_J = 0x0a;
const ARROW_UP = '\u001b[A';
const ARROW_DOWN = '\u001b[B';
// SGR mouse (`ESC [ < … M|m`), legacy mouse (`ESC [ M` plus three bytes), and cursor position
// (`ESC [ … R`). Built rather than written as literals: a regex literal holding a real escape
// character is exactly what the linter refuses, and it is right to.
const REPORTS = [
  new RegExp(`${ESCAPE}\\[<\\d+;\\d+;\\d+[Mm]`, 'g'),
  new RegExp(`${ESCAPE}\\[M[\\s\\S]{3}`, 'g'),
  new RegExp(`${ESCAPE}\\[\\d+;\\d+R`, 'g'),
];

/**
 * Walks history with Ctrl-K and Ctrl-J, by rewriting the bytes before readline sees them.
 *
 * Rewritten rather than handled, for two reasons a keypress listener cannot get around. Ctrl-K
 * already means kill-to-end-of-line, and a second listener does not replace readline's — it runs
 * as well, so the line would be shredded on the way to the previous entry. And Ctrl-J is not a
 * distinguishable key at all: it arrives as `\n`, which readline reads as Enter and every
 * multi-line paste is full of. Binding it by name would stop pastes submitting.
 *
 * The paste is what the single-byte test is for. A keystroke arrives on its own; a paste arrives
 * as a chunk, so a `\n` with company is left exactly as it was and still submits its line.
 *
 * The returned stream stands in for the TTY it wraps — readline needs `isTTY` and `setRawMode` to
 * put the terminal in the mode this depends on, and neither belongs to a plain PassThrough.
 *
 * ```ts
 * import { PassThrough } from 'node:stream';
 * import { vimKeys } from './keys.ts';
 *
 * const stdin = Object.assign(new PassThrough(), { setRawMode: () => {} });
 * vimKeys(stdin as unknown as NodeJS.ReadStream).isTTY; // true — readline needs to believe it
 * ```
 */
export function vimKeys(stdin: NodeJS.ReadStream): NodeJS.ReadStream {
  const translated = new PassThrough();

  stdin.on('data', (chunk: Buffer) => {
    if (chunk.length === 1 && chunk[0] === CTRL_K) return void translated.write(ARROW_UP);
    if (chunk.length === 1 && chunk[0] === CTRL_J) return void translated.write(ARROW_DOWN);
    translated.write(withoutTerminalReports(chunk));
  });
  stdin.on('end', () => translated.end());

  return Object.defineProperties(translated as unknown as NodeJS.ReadStream, {
    isTTY: { value: true },
    setRawMode: { value: (mode: boolean) => stdin.setRawMode(mode) },
  });
}

/**
 * Drops the terminal's answers to itself: mouse reports and cursor-position reports.
 *
 * These are input in the sense that they arrive on stdin, and never in the sense that anyone typed
 * them. An editor turns mouse tracking on; the terminal then reports every click and drag as
 * `ESC [ < 32 ; 14 ; 45 M`, and the ones that arrive while nobody is reading sit in the TTY buffer
 * until somebody is. That somebody was the prompt, which rendered them as text and then failed to
 * parse them — the `32;14;45M32;11;45M…` after quitting nvim, and the `Invalid or unexpected
 * token` on the line after.
 *
 * Filtered by SHAPE rather than by timing: a report is recognisable, and dropping it is right
 * whenever it turns up. A settle window would only be a guess about how long the mess lasts.
 *
 * ```ts
 * import { withoutTerminalReports } from './keys.ts';
 *
 * const ESC = String.fromCharCode(27);
 * withoutTerminalReports(Buffer.from(`a${ESC}[<32;14;45Mb`)).toString(); // 'ab'
 * withoutTerminalReports(Buffer.from('1 + 1')).toString(); // '1 + 1' — ordinary typing is untouched
 * ```
 */
export function withoutTerminalReports(chunk: Buffer): Buffer {
  const text = chunk.toString('binary');
  if (!text.includes(ESCAPE)) return chunk;

  const stripped = REPORTS.reduce((rest, report) => rest.replace(report, ''), text);

  return stripped === text ? chunk : Buffer.from(stripped, 'binary');
}
