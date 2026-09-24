import { PassThrough } from 'node:stream';
import { newVimState, pressKey } from '../../repl/vim.ts';
import type { Line, VimState } from '../../repl/vim.ts';
import type { REPLServer } from 'node:repl';

// The TERMINAL half of vim mode: bytes in, readline's line edited, a caret that says which mode
// you are in. The grammar itself is `lib/repl/vim.ts` and knows nothing about any of this.
//
// Interception happens at the STREAM, not at readline's `keypress` event, and that is the whole
// design. A `keypress` listener does not REPLACE readline's own — it runs as well — so `d` would
// move the caret and insert a `d`. Swallowing the bytes before readline sees them is the only way
// normal mode can mean something different from typing.

const ESCAPE = String.fromCharCode(27);

/** A block caret for normal mode and a bar for insert — what every terminal vi-mode does. */
const CARET_BLOCK = `${ESCAPE}[2 q`;
const CARET_BAR = `${ESCAPE}[6 q`;
/** And back to whatever the terminal had, on the way out. */
const CARET_DEFAULT = `${ESCAPE}[0 q`;

/**
 * Wraps an input stream so that normal mode edits the prompt instead of typing into it.
 *
 * Two halves, because the server does not exist yet when its input has to be chosen:
 * {@link VimInput.stream} is what `node:repl` is given, and {@link VimInput.attach} hands over the
 * server once there is one. Until it is attached, every byte passes through — which is also what
 * makes a non-interactive session unaffected.
 *
 * What normal mode does NOT take: escape sequences (the arrows still work) and control keys
 * (Ctrl-C interrupts, Ctrl-D exits, Ctrl-R searches, TAB completes). vim mode governs the
 * printable keys, and everything a terminal already meant stays meant.
 *
 * ```ts
 * import { PassThrough } from 'node:stream';
 * import { withVimMode } from './vim-mode.ts';
 *
 * const stdin = Object.assign(new PassThrough(), { setRawMode: () => {}, isTTY: true });
 * withVimMode(stdin as unknown as NodeJS.ReadStream).stream.isTTY; // true
 * ```
 */
export function withVimMode(stdin: NodeJS.ReadStream): VimInput {
  const forwarded = new PassThrough();
  let server: REPLServer | null = null;
  let state: VimState = newVimState();

  const internals = () => server as unknown as { _refreshLine(): void };
  const lineNow = (): Line => ({ text: server?.line ?? '', cursor: server?.cursor ?? 0 });

  // Bytes bound for readline are held and written in one go, so a paste stays one paste and a run
  // of typed characters is not a write apiece.
  let held = '';
  const send = (text: string) => void (held += text);
  const flush = () => {
    if (held !== '') forwarded.write(held);
    held = '';
  };

  // Resolvers for keys that cannot be answered until readline has caught up — see `settled`.
  const waiting: Array<() => void> = [];
  const wake = () => {
    while (waiting.length > 0) (waiting.shift() as () => void)();
  };

  /**
   * Writes what is held, and waits for readline to have ACTED on it.
   *
   * This is the whole reason the handler is async, and the reason waiting a tick is not enough:
   * the REPL keeps its input PAUSED between lines, so a write only lands in the stream's buffer
   * and `server.line` still reads `''` however many ticks later. `Esc x` then deleted a character
   * out of an empty string and the keystroke was silently lost. Measured rather than guessed:
   * `flowing=false paused=true buffered=5`, with the line still empty.
   *
   * So the wait is for the EVENT, not for a clock. Our own `data` listener is registered in
   * {@link VimInput.attach}, AFTER readline's, and an EventEmitter runs listeners in registration
   * order — so by the time ours is called with the stream drained, readline's has already run for
   * every byte. Where nothing was held there is nothing to wait for.
   */
  const settled = () =>
    new Promise<void>((resolve) => {
      if (held === '') return void setImmediate(resolve);

      waiting.push(resolve);
      flush();
    });

  const handle = async (chunk: Buffer) => {
    for (const key of keysOf(chunk.toString('utf8'))) {
      // Typing, and the keys a terminal already meant: forwarded without ever reading the line,
      // which is what keeps ordinary insert-mode typing at exactly the cost it had before.
      if (state.mode === 'insert' && key !== ESCAPE) {
        send(key);
        continue;
      }
      if (state.mode === 'normal' && isTerminalsOwn(key)) {
        send(key);
        continue;
      }

      await settled();
      const was = state.mode;
      const step = pressKey(state, lineNow(), key);
      state = step.state;
      if (state.mode !== was) showCaret(server as REPLServer, state.mode);

      if (step.action === 'forward') send(key);
      else if (step.action === 'submit') send('\r');
      else if (step.action === 'historyPrev') send(`${ESCAPE}[A`);
      else if (step.action === 'historyNext') send(`${ESCAPE}[B`);
      else apply(server as REPLServer, internals, step.line);
    }
    flush();
  };

  // Serialised, because two chunks arriving while the first is still awaiting a tick would
  // otherwise interleave their keys — and a vim command half-applied is worse than a slow one.
  let queue: Promise<void> = Promise.resolve();
  stdin.on('data', (chunk: Buffer) => {
    if (server === null) return void forwarded.write(chunk);
    queue = queue.then(() => handle(chunk));
  });
  stdin.on('end', () => void queue.then(() => forwarded.end()));

  return {
    stream: Object.defineProperties(forwarded as unknown as NodeJS.ReadStream, {
      isTTY: { value: true },
      setRawMode: { value: (mode: boolean) => stdin.setRawMode(mode) },
    }),
    attach(attached: REPLServer) {
      server = attached;
      // Registered AFTER readline's own `data` listener, which is what makes this a reliable
      // "it has been read" signal rather than a second reader racing the first.
      forwarded.on('data', () => {
        if (forwarded.readableLength === 0) wake();
      });
      showCaret(attached, state.mode);
      // The caret shape is this process's doing, so putting it back is too — a session that exits
      // leaving a block caret behind has broken the shell it was launched from.
      attached.on('exit', () => void attached.output.write(CARET_DEFAULT));
    },
    get mode() {
      return state.mode;
    },
  };
}

/** What {@link withVimMode} hands back: the stream to read, and the server to bind to. */
export interface VimInput {
  /** The stream to give `node:repl` in place of stdin. */
  stream: NodeJS.ReadStream;
  /** Hands over the server once it exists, which is when normal mode starts working. */
  attach(server: REPLServer): void;
  /** Which mode the prompt is in — for anything that wants to say so on screen. */
  readonly mode: 'insert' | 'normal';
}

/**
 * Writes a line and a caret position back into readline, and redraws.
 *
 * `line` and `cursor` are readline's own record of what is on screen, so setting them and asking
 * for a refresh is the whole of it — every other thing hooked onto the prompt (the highlighter,
 * the right-margin preview) draws from the same two fields and therefore stays correct.
 */
function apply(server: REPLServer, internals: () => { _refreshLine(): void }, line: Line): void {
  const target = server as unknown as { line: string; cursor: number };
  if (target.line === line.text && target.cursor === line.cursor) return;

  target.line = line.text;
  target.cursor = line.cursor;
  internals()._refreshLine();
}

/** Tells the terminal which caret to draw. Ignored where DECSCUSR is not understood, harmlessly. */
function showCaret(server: REPLServer, mode: 'insert' | 'normal'): void {
  server.output.write(mode === 'normal' ? CARET_BLOCK : CARET_BAR);
}

/**
 * Whether a key belongs to the terminal rather than to the grammar.
 *
 * An escape sequence is an arrow, a Home, a paste bracket — things readline already answers. A
 * control character is Ctrl-C, Ctrl-D, Ctrl-R, TAB: bindings that mean the same thing in every
 * mode, and taking them away would be taking away the prompt.
 *
 * Enter is deliberately NOT one of these: the grammar returns `submit` for it, which is how a
 * half-typed command is dropped before the line runs.
 *
 * ```ts
 * import { isTerminalsOwn } from './vim-mode.ts';
 *
 * const ESC = String.fromCharCode(27);
 * isTerminalsOwn(`${ESC}[A`); // true — an arrow
 * isTerminalsOwn(String.fromCharCode(3)); // true — Ctrl-C
 * isTerminalsOwn('w'); // false — that is a motion
 * isTerminalsOwn('\r'); // false — the grammar answers Enter
 * ```
 */
export function isTerminalsOwn(key: string): boolean {
  if (key.length > 1) return true;
  if (key === '\r' || key === '\n' || key === ESCAPE) return false;

  return (key.codePointAt(0) ?? 32) < 0x20;
}

/**
 * Splits a chunk into keys, an escape sequence counting as one.
 *
 * The important case is a lone Escape followed by a letter. Terminals send Alt-W as `ESC W`, and
 * they send Escape-then-W as `ESC W` too when the two arrive inside one read — which at a vim
 * prompt is constantly, because leaving insert mode and giving a command is one gesture. Reading
 * that as Alt-W would make every fast `Esc w` do nothing, so only `ESC [` and `ESC O` — the
 * sequences a terminal actually generates for keys — are kept whole.
 *
 * ```ts
 * import { keysOf } from './vim-mode.ts';
 *
 * const ESC = String.fromCharCode(27);
 * keysOf('abc'); // ['a', 'b', 'c']
 * keysOf(`${ESC}[A`).length; // 1 — one arrow, not three keys
 * keysOf(`${ESC}w`).length; // 2 — Escape, then a motion
 * ```
 */
export function keysOf(text: string): string[] {
  return text.match(ONE_KEY) ?? [];
}

/**
 * An escape sequence, or one code point.
 *
 * `u` is what makes the fallback a CODE POINT rather than a UTF-16 unit, so an emoji pasted at
 * the prompt is one key and not two halves of a surrogate pair.
 */
const ONE_KEY = new RegExp(
  // Built rather than written as a literal: a literal Escape inside one is a control
  // character, which the linter is right to object to in the general case.
  `${ESCAPE}(?:\\[[0-9;?]*[ -/]*[@-~]|O[@-~])|[\\s\\S]`,
  'gu',
);
