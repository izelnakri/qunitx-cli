import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { blue, red } from '../../utils/color.ts';
import { failureText } from './command.ts';
import { openInBrowser } from './open-in-browser.ts';
import type { REPLServer } from 'node:repl';
import type { ReplCommand, ReplContext } from './command.ts';

/**
 * The lines of a session worth replaying: everything typed, minus the shell escapes.
 *
 * The lines are `node:repl`'s own record of what it evaluated, which {@link ReplContext.lines}
 * reads off the server — absent from `@types/node`'s `REPLServer`, so the cast lives there, once,
 * rather than at every caller.
 *
 * ```ts
 * import { replayableSource } from './editor.ts';
 *
 * replayableSource(['1 + 1', ':git status', '2 + 2']); // '1 + 1\n2 + 2\n'
 * ```
 */
export function replayableSource(lines: readonly string[]): string {
  return lines
    .filter((line) => !line.trimStart().startsWith(':'))
    .map((line) => `${line}\n`)
    .join('');
}

/**
 * True when the file was written. A save that cannot land is a message, not a crashed session.
 *
 * ```ts
 * import { writeIfPossible } from './editor.ts';
 *
 * writeIfPossible('/definitely/not/here/a.txt', 'x'); // false
 * ```
 */
export function writeIfPossible(file: string, contents: string): boolean {
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
 * `aborted` is the other way to say never mind, for when you HAVE saved: `:cq` leaves vim with a
 * non-zero status, which is the same signal `git commit` reads to throw a message away. It is the
 * only "do not use this" an editor can send that the file cannot, because `:wq` and `:w` followed
 * by `:q` leave a byte-identical file and both exit 0.
 *
 * ```ts
 * import type { REPLServer } from 'node:repl';
 * import { edit } from './editor.ts';
 *
 * // Defined, not invoked: it takes over the terminal.
 * function example(server: REPLServer) {
 *   return edit('vi', 'const x = 1;', server); // { text, changed, aborted }
 * }
 * ```
 */
export async function edit(
  editor: string,
  contents: string,
  server: REPLServer,
): Promise<{ text: string; changed: boolean; aborted: boolean }> {
  // Unique per call, not per process: two edits in flight at once would otherwise open the same
  // path and each would save over the other's buffer.
  const file = path.join(os.tmpdir(), `qunitx-repl-${process.pid}-${randomUUID()}.js`);
  fs.writeFileSync(file, contents);

  try {
    const left = await handOver(server, editor, [file]);
    const text = readIfThere(file) ?? contents;

    return { text, changed: text !== contents, aborted: left.started && left.code !== 0 };
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
 * whatToRun({ text: '1 + 1', changed: true, aborted: false }); // '1 + 1'
 * whatToRun({ text: '1 + 1', changed: false, aborted: false }); // '' — never saved, never mind
 * whatToRun({ text: '1 + 1', changed: true, aborted: true }); // '' — saved, then `:cq`
 * ```
 */
export function whatToRun(edited: { text: string; changed: boolean; aborted: boolean }): string {
  return edited.changed && !edited.aborted ? edited.text.trim() : '';
}

/**
 * A file's contents, or null when it cannot be read — a missing path is an answer, not a crash.
 *
 * ```ts
 * import { readIfThere } from './editor.ts';
 *
 * readIfThere('/definitely/not/here'); // null
 * ```
 */
export function readIfThere(file: string): string | null {
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
 * Resolves `{ started: false }` where the child could not be started, which is the one failure
 * worth telling anybody about. `code` is how the editor CHOSE to leave: every normal way out of
 * vim, nvim, emacs, nano and helix exits 0, and `:cq` — the one git already reads to abort a
 * commit — exits non-zero. It is the only thing an editor tells us that the file does not.
 */
async function handOver(
  server: REPLServer,
  command: string,
  args: string[],
): Promise<{ started: boolean; code: number | null }> {
  pausePrompt(server);
  const stdin = process.stdin;
  const wasRaw = Boolean(stdin.isRaw);
  const wasFlowing = stdin.readableFlowing === true;
  stdin.pause();
  if (wasRaw) stdin.setRawMode(false);

  try {
    return await new Promise<{ started: boolean; code: number | null }>((resolve) => {
      const child = spawn(command, args, { stdio: 'inherit' });
      child.on('error', () => resolve({ started: false, code: null }));
      child.on('close', (code) => resolve({ started: true, code }));
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
    resumePrompt(server);
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
 * import { pausePrompt } from './editor.ts';
 *
 * import type { REPLServer } from 'node:repl';
 *
 * // Defined, not invoked: it stops a live prompt.
 * function example(server: REPLServer) {
 *   pausePrompt(server); // and `standUp` when whatever it was doing is done
 * }
 * ```
 */
export function pausePrompt(server: REPLServer): void {
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
 * import { resumePrompt } from './editor.ts';
 *
 * import type { REPLServer } from 'node:repl';
 *
 * // Defined, not invoked: it resumes a live prompt.
 * function example(server: REPLServer) {
 *   resumePrompt(server); // a no-op where there is no longer a prompt to resume
 * }
 * ```
 */
export function resumePrompt(server: REPLServer): void {
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

  const before = readIfThere(file);
  // The same handover the scratchpad makes: readline stands down, the editor owns the terminal,
  // and it is given back only to a prompt that had it.
  // Only `started` here, not the exit code. `:cq` on the SCRATCHPAD means "do not run this"; on a
  // real file it would mean "pretend I did not save", and the file on disk is saved either way —
  // refusing to notice would put the session back out of step with it, which is the whole thing
  // this path exists to prevent.
  const { started } = await handOver(server, editor, [`+${line}`, file]);

  return {
    failed: started ? null : `${editor} could not be started\n`,
    changed: started && readIfThere(file) !== before,
  };
}

/**
 * What `.open` and every editor-named spelling of it do, differing only in which editor they mean.
 *
 * `named` is the editor the command is named after — `.vi` means vi — and `undefined` for the ones
 * that mean whichever the environment prefers. Everything else is one command doing what
 * `xdg-open` does: with nothing after it the session's own scratchpad, with an address the browser
 * already running, and with anything else an editor, on the file a value is declared in or on the
 * path itself, whether or not there is a file there yet.
 *
 * ```ts
 * import { openingIn } from './editor.ts';
 *
 * typeof openingIn('vi'); // 'function' — a command's `main`, waiting for a context
 * ```
 */
export function openingIn(editor: string): ReplCommand['main'] {
  return editorCommand(editor, editor);
}

/**
 * `.open`, `.edit` and `.e` — whichever editor the environment prefers.
 *
 * ```ts
 * import { opening } from './editor.ts';
 *
 * typeof opening('open'); // 'function' — a command's `main`, waiting for a context
 * ```
 */
export function opening(name: string): ReplCommand['main'] {
  return editorCommand(name);
}

/**
 * What `.open` and every editor-named spelling of it do, differing only in which editor they mean.
 *
 * `named` is the editor the command is named after — `.vi` means vi — and absent for the ones that
 * mean whichever the environment prefers. Private, because a caller should be picking between the
 * two public spellings rather than passing a maybe-editor.
 */
function editorCommand(name: string, named?: string): ReplCommand['main'] {
  return async (repl, argument) => {
    const asked = argument.trim();
    if (!repl.interactive && asked === '') {
      repl.log(red(`.${name} needs a terminal`));

      return;
    }
    if (asked === '') return scratchpad(repl, named);
    if (isAddress(asked)) {
      repl.log((await openInBrowser(asked)) ?? blue(asked));

      return;
    }

    // The keyboard stops being the prompt's here, not when the editor opens: asking the page where
    // a value is written is a round trip, and a line typed during it is a line meant for after the
    // editor, not one to run while it is up.
    pausePrompt(repl.server);
    const declared = await repl.session.declaredAt(asked);
    // A function knows its own line. Everything else that came into this session came from a
    // file too, and anything that is neither is a path — one that need not exist yet, since
    // opening an editor on a name is how a file starts.
    const from = repl.session.whereFrom(asked);
    const at = declared ?? { file: from ?? asked, line: 1 };
    // A pipe has no terminal to hand over, and an editor given one anyway waits for a human who
    // is not there — the session simply stops. Where it cannot open it, the place is still worth
    // saying.
    if (!repl.interactive) {
      resumePrompt(repl.server);
      repl.log(blue(`${at.file}:${at.line}`));

      return;
    }
    const opened = await openInEditor(path.resolve(repl.cwd, at.file), at.line, repl.server, named);
    resumePrompt(repl.server);
    if (opened.failed !== null) repl.write(opened.failed);
    // A file the session has in scope and the file on disk are the same file, and this is how
    // the second one changes. Saving it and then having to `.load` it by hand is the session
    // going stale under you at the moment you were least expecting it to.
    else if (opened.changed) {
      const brought = await repl.session.refresh(at.file);
      if (typeof brought === 'string') repl.write(red(`${brought}\n`));
      else if (brought !== null) repl.write(blue(`${brought.join(', ')}\n`));
    }
  };
}

/**
 * The session's own buffer, opened: one buffer for the life of the session, whichever name opened
 * it, so reopening continues the same thought rather than starting a blank one.
 *
 * AWAITED, not fired and forgotten. `define` draws the prompt when a command's `main` settles, so
 * a `main` that returned while the editor was still opening got its prompt drawn then — and after
 * the editor closed, and the question was answered, nothing drew another. The session looked
 * hung: you answered, and had to press Enter again to get a prompt back.
 */
function scratchpad(repl: ReplContext, named?: string): Promise<void> {
  const editor = named ?? process.env.VISUAL ?? process.env.EDITOR ?? 'vi';

  return edit(editor, repl.scratch, repl.server).then(async (edited) => {
    repl.scratch = edited.text;
    const source = whatToRun(edited);
    if (source === '' || !(await confirmRun(repl, source))) return;

    // `whole`, because you closed the editor: there is no more of this coming. Without it an
    // unfinished last statement came back as `incomplete` — the prompt's "keep typing" — and a
    // buffer you had just saved did nothing at all and said nothing about it.
    const result = await repl.session.eval(source, { whole: true });
    const text = result.failed ? red(failureText(result)) : result.output;
    if (text !== '') repl.log(text);
  });
}

/**
 * Asks before running what the editor left, and defaults to yes.
 *
 * Inferring the answer from how you quit is not possible, and it was worth measuring before
 * believing: `:wq`, `:x`, and `:w` followed by `:q!` leave a byte-identical file, all exit 0, and
 * the gap between the write and the exit differs by about four milliseconds. There is nothing
 * there to read, so this asks instead of guessing — which also means one rule for every editor,
 * rather than a `$EDITOR`-shaped one.
 *
 * `[Y/n]`, because saving usually does mean run it. Anything starting with `n` is no; Enter, `y`,
 * or anything else is yes.
 */
function confirmRun(repl: ReplContext, source: string): Promise<boolean> {
  const lines = source.split('\n').length;

  return new Promise((resolve) => {
    repl.server.question(`run ${lines} line${lines === 1 ? '' : 's'}? [Y/n] `, (answer) => {
      resolve(meansYes(answer));
    });
  });
}

/**
 * How an answer to `[Y/n]` is read: Enter, or anything starting with `y`. Everything else is no.
 *
 * Deliberately strict in that direction. Most `[Y/n]` prompts take anything-but-`n` as yes, but
 * this one RUNS CODE, and the complaint it exists to answer is code running when nobody asked for
 * it. A prompt that reads a mistyped `.exit` as consent is the same bug with an extra step.
 *
 * Its own function because it is the whole of the decision, and a decision made inside a callback
 * inside a promise is one nothing can test without a terminal.
 *
 * ```ts
 * import { meansYes } from './editor.ts';
 *
 * meansYes(''); // true — Enter takes the default, which is to run it
 * meansYes('y'); // true
 * meansYes('  YES  '); // true — trimmed, and case does not matter
 * meansYes('n'); // false
 * meansYes('.exit'); // false — a stray command is not consent
 * ```
 */
export function meansYes(answer: string): boolean {
  const said = answer.trim().toLowerCase();

  return said === '' || said.startsWith('y');
}

/**
 * Whether this is an address rather than a path — what a browser takes and an editor does not.
 *
 * `https://localhost:1234` is one; `lib/repl/session.ts` is not, whether or not a file is there
 * yet. Private, and here rather than beside `openInBrowser`: `.open` is the only thing that has to
 * tell the two apart, because it is the only command that accepts either.
 */
function isAddress(target: string): boolean {
  return /^(?:https?|file|about|chrome):/i.test(target) || /^www\./i.test(target);
}
