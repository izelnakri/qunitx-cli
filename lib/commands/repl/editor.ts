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
 * ```ts
 * import type { REPLServer } from 'node:repl';
 * import { edit } from './editor.ts';
 *
 * // Defined, not invoked: it takes over the terminal.
 * function example(server: REPLServer) {
 *   return edit('vi', 'const x = 1;', server); // resolves with whatever was saved
 * }
 * ```
 */
export async function edit(editor: string, contents: string, server: REPLServer): Promise<string> {
  // Unique per call, not per process: two edits in flight at once would otherwise open the same
  // path and each would save over the other's buffer.
  const file = path.join(os.tmpdir(), `qunitx-repl-${process.pid}-${randomUUID()}.js`);
  fs.writeFileSync(file, contents);

  try {
    await handOver(server, editor, [file]);

    return tryReadFile(file) ?? contents;
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone, which is where it was headed.
    }
  }
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
  server.pause();
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
    server.resume();
  }
}

/**
 * Opens a file at a line in the developer's editor, or says why it could not.
 *
 * `+LINE file` is the argument every terminal editor since vi has taken, and the ones that do not
 * ignore it and open the file anyway — which is still the thing that was asked for.
 *
 * Resolves with `null` when the editor ran, or with the line to print when it could not: no
 * `$EDITOR` set, or one that is not there.
 *
 * ```ts
 * import { openInEditor } from './editor.ts';
 *
 * import type { REPLServer } from 'node:repl';
 *
 * // Defined, not invoked: it hands a real terminal to a real editor.
 * function example(server: REPLServer) {
 *   return openInEditor('/proj/a.ts', 12, server); // null once the editor has exited
 * }
 * ```
 */
export async function openInEditor(
  file: string,
  line: number,
  server: REPLServer,
): Promise<string | null> {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) return 'no $EDITOR set — nothing to open it with\n';

  // The same handover `.nvim` makes: readline stands down, the editor owns the terminal, and it
  // is given back only to a prompt that had it.
  const started = await handOver(server, editor, [`+${line}`, file]);

  return started ? null : `${editor} could not be started\n`;
}
