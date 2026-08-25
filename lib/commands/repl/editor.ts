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

/** True when the file was written. A save that cannot land is a message, not a crashed session. */
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
  server.pause();
  const stdin = process.stdin;
  const wasRaw = Boolean(stdin.isRaw);
  // Both halves of how stdin was found, because both have to be put back. Resuming a stream that
  // was not flowing does not restore anything — it STARTS something, and a flowing stdin holds the
  // event loop open for as long as the process lives. `readableFlowing` and not `isPaused()`:
  // a stdin nobody has read yet is neither flowing nor paused, and `isPaused()` calls that false.
  const wasFlowing = stdin.readableFlowing === true;
  stdin.pause();
  if (wasRaw) stdin.setRawMode(false);

  try {
    await new Promise<void>((resolve) => {
      const child = spawn(editor, [file], { stdio: 'inherit' });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    });

    return tryReadFile(file) ?? contents;
  } finally {
    if (wasRaw) stdin.setRawMode(true);
    // Handing the terminal back, and only to a prompt that had it. Whatever the editor left in the
    // buffer is the editor's, not the next line's — a half-read escape sequence typed at a prompt
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
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone, which is where it was headed.
    }
  }
}

/** A file's contents, or null when it cannot be read — a missing path is an answer, not a crash. */
export function tryReadFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
