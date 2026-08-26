import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { REPLServer } from 'node:repl';

/**
 * The lines of a session worth replaying: everything typed, minus the shell escapes.
 *
 * `lines` is `node:repl`'s own record of what it evaluated and is absent from `@types/node`'s
 * `REPLServer`, so it is reached through a narrow cast rather than by widening the whole server.
 *
 * ```ts
 * import { replayableLines } from './editor.ts';
 *
 * replayableLines({ lines: ['1 + 1', ':git status', '2 + 2'] }); // ['1 + 1', '2 + 2']
 * ```
 */
export function replayableLines(server: { lines?: string[] }): string[] {
  return (server.lines ?? []).filter((line) => !line.trimStart().startsWith(':'));
}

/**
 * True when the file was written. A save that cannot land is a message, not a crashed session.
 *
 * ```ts
 * import { tryWriteFile } from './editor.ts';
 *
 * tryWriteFile('/definitely/not/here/a.txt', 'x'); // false
 * ```
 */
export function tryWriteFile(file: string, contents: string): boolean {
  try {
    fs.writeFileSync(file, contents);

    return true;
  } catch {
    return false;
  }
}

/**
 * Hands the terminal to an editor, and takes back whatever was saved.
 *
 * The REPL is holding the TTY in raw mode with a readline attached, and an editor needs both back.
 * Three things have to happen, and the middle one is the one that bites.
 *
 * `server.pause()` stops readline. `stdin.pause()` stops NODE reading fd 0 — without it both this
 * process and the editor read the same descriptor and race for every byte. nvim loses keystrokes,
 * and its terminal reports arrive at the prompt instead of at nvim: `32;14;45M` and friends, which
 * are SGR mouse events, spilling into the line after a session that looked fine until you quit.
 * Raw mode is lifted last, because the editor sets whatever modes it wants and restores them on
 * exit; anything still owned by Node at that point is what survives to corrupt the next line.
 *
 * NOT `detached`. A detached child leads its own process group, which is not the terminal's
 * foreground group — the first read from the TTY would stop it with SIGTTIN. Inheriting the
 * terminal while its reader stands down is what "it owns the screen" actually means here.
 *
 * The buffer travels through a file because that is the only thing an editor talks. It comes back
 * as a string, and the CALLER keeps it: the session's scratchpad lives for as long as the session,
 * so reopening continues the same thought rather than starting a blank one.
 *
 * A `.js` extension, because whatever an editor does with syntax and indentation should be what it
 * would do for the file this text is going to behave like.
 *
 * What comes back says whether the text CHANGED, not merely whether it was saved. Quitting without
 * writing means "never mind", and a scratchpad that runs what you just walked away from is a
 * scratchpad you stop using for anything you are not sure about.
 *
 * ```ts
 * import type { REPLServer } from 'node:repl';
 * import { edit } from './editor.ts';
 *
 * // Defined, not invoked: it takes over the terminal.
 * function example(server: REPLServer) {
 *   return edit('vi', 'const x = 1;', server); // { text: whatever was saved, changed: boolean }
 * }
 * ```
 */
export async function edit(
  editor: string,
  contents: string,
  server: REPLServer,
): Promise<{ text: string; changed: boolean }> {
  // Unique per call, not per process: two edits in flight at once would otherwise open the same
  // path and each would save over the other's buffer.
  const file = path.join(os.tmpdir(), `qunitx-repl-${process.pid}-${randomUUID()}.js`);
  fs.writeFileSync(file, contents);

  try {
    await handOver(server, editor, [file]);
    const text = tryReadFile(file) ?? contents;

    return { text, changed: text !== contents };
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone, which is where it was headed.
    }
  }
}

/**
 * What an edit leaves to run: the buffer where it moved, and nothing where it did not.
 *
 * Quitting without writing means "never mind", and a scratchpad that runs what you just walked
 * away from is one you stop using for anything you are not sure about. A buffer emptied and saved
 * runs nothing either, for the same reason it would at the prompt.
 *
 * The comparison is of CONTENT, not of whether a write happened: an editor that saves a buffer
 * nobody touched has changed nothing, whatever it did to the mtime.
 *
 * ```ts
 * import { whatToRun } from './editor.ts';
 *
 * whatToRun({ text: '1 + 1', changed: true }); // '1 + 1'
 * whatToRun({ text: '1 + 1', changed: false }); // '' — quit without saving, so never mind
 * ```
 */
export function whatToRun(edited: { text: string; changed: boolean }): string {
  return edited.changed ? edited.text.trim() : '';
}

/**
 * A file's contents, or null when it cannot be read — a missing path is an answer, not a crash.
 *
 * ```ts
 * import { tryReadFile } from './editor.ts';
 *
 * tryReadFile('/definitely/not/here'); // null
 * ```
 */
export function tryReadFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Gives the terminal to a child process, waits for it, and takes it back.
 *
 * Both halves of how stdin was found have to be put back. Resuming a stream that was not flowing
 * does not restore anything — it STARTS something, and a flowing stdin holds the event loop open
 * for as long as the process lives. `readableFlowing` and not `isPaused()`: a stdin nobody has
 * read yet is neither flowing nor paused, and `isPaused()` calls that false.
 *
 * Resolves `false` where the child could not be started, which is the one failure worth telling
 * anybody about; everything else it does is the child's business.
 */
async function handOver(server: REPLServer, command: string, args: string[]): Promise<boolean> {
  standDown(server);
  const stdin = process.stdin;
  const wasRaw = Boolean(stdin.isRaw);
  const wasFlowing = stdin.readableFlowing === true;
  stdin.pause();
  if (wasRaw) stdin.setRawMode(false);

  try {
    return await new Promise<boolean>((resolve) => {
      const child = spawn(command, args, { stdio: 'inherit' });
      child.on('error', () => resolve(false));
      child.on('close', () => resolve(true));
    });
  } finally {
    if (wasRaw) stdin.setRawMode(true);
    // Handing the terminal back, and only to a prompt that had it. Whatever the child left in the
    // buffer is the child's, not the next line's — a half-read escape sequence typed at a prompt
    // is the garbage this whole handover exists to avoid. Where nothing was reading stdin, neither
    // half applies: `read()` restarts the flow it drains, and a stdin left flowing with no reader
    // holds the event loop open for the life of the process.
    if (wasFlowing) {
      while (stdin.read() !== null) {
        // Discarding, deliberately.
      }
      stdin.resume();
    }
    standUp(server);
  }
}

/**
 * Stops the prompt reading, because what happens next is not the prompt's.
 *
 * Called before the editor rather than at the handover, so that everything between the command and
 * the editor opening — asking the page where a value is written, most of the time — is time the
 * keyboard belongs to nobody. Lines typed then are lines meant for AFTER the editor, and readline
 * would otherwise run them while it was still up.
 *
 * ```ts
 * import { standDown } from './editor.ts';
 *
 * import type { REPLServer } from 'node:repl';
 *
 * // Defined, not invoked: it stops a live prompt.
 * function example(server: REPLServer) {
 *   standDown(server); // and `standUp` when whatever it was doing is done
 * }
 * ```
 */
export function standDown(server: REPLServer): void {
  if (!closed(server)) server.pause();
}

/**
 * Gives the prompt back its input — unless the session has gone.
 *
 * A command can outlive the session that started it: `.exit` on the line after an `.open` arrives
 * while the editor is still up, and readline throws `ERR_USE_AFTER_CLOSE` at whoever asks it for
 * anything afterwards. Out of a `finally`, that takes the process with it.
 *
 * ```ts
 * import { standUp } from './editor.ts';
 *
 * import type { REPLServer } from 'node:repl';
 *
 * // Defined, not invoked: it resumes a live prompt.
 * function example(server: REPLServer) {
 *   standUp(server); // a no-op where there is no longer a prompt to resume
 * }
 * ```
 */
export function standUp(server: REPLServer): void {
  if (!closed(server)) server.resume();
}

function closed(server: REPLServer): boolean {
  return (server as unknown as { closed?: boolean }).closed === true;
}

/**
 * Opens a file at a line in the developer's editor, or says why it could not.
 *
 * `+LINE file` is the argument every terminal editor since vi has taken, and the ones that do not
 * ignore it and open the file anyway — which is still the thing that was asked for.
 *
 * `failed` is the line to print when it could not run: no `$EDITOR` set, or one that is not
 * there. `changed` says whether the file is different from the one that was opened, which is how
 * a caller knows a file the session had in scope has moved out from under it. `named` is for the
 * commands named after an editor, which mean that one rather than whichever the environment
 * prefers.
 *
 * ```ts
 * import { openInEditor } from './editor.ts';
 *
 * import type { REPLServer } from 'node:repl';
 *
 * // Defined, not invoked: it hands a real terminal to a real editor.
 * function example(server: REPLServer) {
 *   return openInEditor('/proj/a.ts', 12, server); // { failed: null, changed: boolean }
 * }
 * ```
 */
export async function openInEditor(
  file: string,
  line: number,
  server: REPLServer,
  named?: string,
): Promise<{ failed: string | null; changed: boolean }> {
  const editor = named ?? process.env.VISUAL ?? process.env.EDITOR;
  if (!editor) return { failed: 'no $EDITOR set — nothing to open it with\n', changed: false };

  const before = tryReadFile(file);
  // The same handover the scratchpad makes: readline stands down, the editor owns the terminal,
  // and it is given back only to a prompt that had it.
  const started = await handOver(server, editor, [`+${line}`, file]);

  return {
    failed: started ? null : `${editor} could not be started\n`,
    changed: started && tryReadFile(file) !== before,
  };
}

/**
 * Hands an address to whatever this desktop opens addresses with — the browser already running.
 *
 * `xdg-open`, `open` and `start` are the same idea under three names, and the point of using them
 * rather than launching a browser is that they land in the window that is already open, logged in,
 * and has your tabs in it.
 *
 * Detached and with its output thrown away: a desktop opener is a doorbell, not a program this
 * session waits on, and some of them chatter on stderr while doing exactly what was asked.
 *
 * ```ts
 * import { openExternally } from './editor.ts';
 *
 * // Defined, not invoked: it puts a window on somebody's screen.
 * function example() {
 *   return openExternally('https://localhost:1234'); // null once handed over
 * }
 * ```
 */
export function openExternally(address: string): Promise<string | null> {
  const opener = OPENERS[process.platform] ?? OPENERS.default;
  if (!opener) return Promise.resolve(`no way to open ${address} on ${process.platform}\n`);

  return new Promise((resolve) => {
    const [command, ...args] = opener;
    const child = spawn(command as string, [...args, address], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => resolve(`${command} could not be started\n`));
    child.unref();
    // Answered as soon as it is running: what it does next belongs to the desktop, not to this
    // prompt, and waiting for a browser window to close is not a thing anybody meant by `.open`.
    setTimeout(() => resolve(null), 0);
  });
}

/** What each desktop calls its opener. `start` is a shell builtin, so it needs one. */
const OPENERS: Record<string, string[] | undefined> = {
  darwin: ['open'],
  win32: ['cmd', '/c', 'start', ''],
  default: ['xdg-open'],
};

/**
 * Whether this is an address rather than a path — what a browser takes and an editor does not.
 *
 * ```ts
 * import { isAddress } from './editor.ts';
 *
 * isAddress('https://localhost:1234'); // true
 * isAddress('lib/repl/session.ts'); // false — a path, whether or not there is a file there yet
 * ```
 */
export function isAddress(target: string): boolean {
  return /^(?:https?|file|about|chrome):/i.test(target) || /^www\./i.test(target);
}
