import { ESCAPE, plain, plainLength, truncate } from '../../repl/columns.ts';
import type { REPLServer } from 'node:repl';
import type { ReplSession } from '../../repl/session.ts';

// How wide a terminal has to be before an answer can share the line with the question. Under this
// the two fight for the same columns and the answer wins arguments it should not.
const PREVIEW_MINIMUM_COLUMNS = 60;
// And how much room the answer needs to be worth drawing. Less than this is an ellipsis with a
// character in front of it.
const PREVIEW_MINIMUM_WIDTH = 12;
// The gap between what is typed and what it comes to, so the two never read as one expression.
const PREVIEW_GAP = 2;
// Long enough that a burst of typing asks once, short enough to feel like it answered as you went.
const PREVIEW_DELAY_MS = 90;

/**
 * What the line would come to, drawn dimmed against the right margin while it is still being typed.
 *
 * ```
 * > document.title                                              'qunitx repl'
 * ```
 *
 * Free by construction: the session evaluates with V8 refusing anything that has a side effect, so
 * an expression that would change something answers nothing at all rather than changing it. What
 * is left is worth showing before Enter, which is the whole point — the answer to `1 + 1` is not
 * worth a round of the read-eval-print loop.
 *
 * Drawn only where there is room for it, and on ONE line. A narrow terminal, a line already near
 * the edge, a value that needs more columns than are left: in each case it is cut to the room or
 * not drawn at all, because a preview that crowds the line it belongs to costs more than it gives.
 * Painted in the colours the page rendered it in, which are the colours the same value will be
 * printed in a keystroke later.
 *
 * ```ts
 * import { setupPreview } from './preview.ts';
 *
 * import type { REPLServer } from 'node:repl';
 * import type { ReplSession } from '../../repl/session.ts';
 *
 * // Defined, not invoked: it evaluates in a live page and draws on a live terminal.
 * function example(server: REPLServer, session: ReplSession) {
 *   setupPreview(server, session, () => false); // never busy, nothing else on the row
 * }
 * ```
 */
export function setupPreview(
  server: REPLServer,
  session: ReplSession,
  busy: () => boolean,
  reserved: () => string = () => '',
): void {
  let timer: NodeJS.Timeout | undefined;

  const room = (line: string): number => {
    const columns = (server.output as NodeJS.WriteStream).columns ?? 0;
    // The suggestion counts: it is drawn after the cursor on this same row, and a preview that
    // ignores it lands on top of the tail of what it is offering.
    const used = plainLength(server.getPrompt()) + line.length + plainLength(reserved());
    // A line that has already wrapped has no right margin left to draw against, and working out
    // where its rows are is arithmetic readline has already done for itself.
    if (columns < PREVIEW_MINIMUM_COLUMNS || used >= columns) return 0;

    return columns - used - PREVIEW_GAP;
  };

  const ask = () => {
    const line = server.line ?? '';
    // A dot command is not an expression, `:` is the shell, and an unfinished line is not worth
    // asking about — the answer to half a line is a syntax error nobody typed yet.
    const askable =
      line.trim() !== '' &&
      !line.trimStart().startsWith('.') &&
      !line.trimStart().startsWith(':') &&
      !busy() &&
      room(line) >= PREVIEW_MINIMUM_WIDTH;
    if (!askable) return;

    void session.preview(line).then((rendered) => {
      // ONE line, whatever it took to render. `window.self` comes back as a page of an object
      // graph, and a value that shares a row with what is being typed cannot bring its own rows
      // with it — the newlines land in the middle of the prompt and take the layout apart.
      const value = rendered.replace(/\s*\n\s*/g, ' ');
      // Decisions are made on the text, drawing on the colours: a value rendered as `undefined`
      // is dim, and dim is escape codes that would never compare equal to anything.
      const text = plain(value);
      // The line may have moved on while the page was answering, and an answer to a line nobody is
      // typing any more is worse than none.
      if (text === '' || text === 'undefined' || server.line !== line) return;
      // Typing `42` and being told `42` is not information.
      if (text === line.trim()) return;
      const width = room(line);
      if (width < PREVIEW_MINIMUM_WIDTH) return;

      draw(truncate(value, width));
    });
  };

  const draw = (value: string) => {
    const columns = (server.output as NodeJS.WriteStream).columns ?? 0;
    const cursor = plainLength(server.getPrompt()) + (server.cursor ?? 0) + 1;
    const at = columns - plainLength(value) + 1;
    // Out to the right margin and back to where the cursor was, in one write, so nothing is ever
    // on screen with the caret in the wrong place. Erased by readline's own redraw on the next
    // keystroke, which clears from the cursor to the end of the screen.
    server.output.write(`${ESCAPE}[${at}G${value}${ESCAPE}[0m${ESCAPE}[${cursor}G`);
  };

  server.input.on('keypress', () => {
    clearTimeout(timer);
    // After a pause in the typing, not during it: every request is a round trip to the page, and
    // the answer to a line half typed is thrown away by the next keystroke anyway.
    timer = setTimeout(ask, PREVIEW_DELAY_MS);
    // Never the reason the process stays alive.
    timer.unref();
  });
}
