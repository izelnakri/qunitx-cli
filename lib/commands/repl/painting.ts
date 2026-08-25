import { highlight } from '../../repl/highlight.ts';
import type { REPLServer } from 'node:repl';
import type { Theme } from '../../repl/theme.ts';

/**
 * Paints the line as it is typed, in the colours the theme gives each capture.
 *
 * Two halves. `_writeToOutput` is where readline puts the prompt and the line on screen, so that
 * is where the line is swapped for a painted one — the substitution is by VALUE, and anything
 * that is not exactly what readline believes the line to be passes through untouched. And a
 * refresh is asked for on every keypress, because readline appends a typed character in place
 * rather than redrawing, and a keyword cannot be recognised one character at a time.
 *
 * Only what is written changes, never what readline computed: the painted line occupies the same
 * columns as the plain one, so every cursor position readline worked out still lands where it
 * meant to.
 *
 * ```ts
 * import { setupHighlighting } from './painting.ts';
 * import { theme } from '../../repl/theme.ts';
 *
 * import type { REPLServer } from 'node:repl';
 *
 * // Defined, not invoked: it draws on a live terminal.
 * function example(server: REPLServer) {
 *   setupHighlighting(server, theme());
 * }
 * ```
 */
export function setupHighlighting(server: REPLServer, palette: Theme): void {
  const internals = server as unknown as {
    _writeToOutput(text: string): void;
    _refreshLine(): void;
  };
  const write = internals._writeToOutput.bind(server);

  internals._writeToOutput = (text: string) => {
    const line = server.line ?? '';
    const prompt = server.getPrompt();
    // Exactly the prompt and the line, which is what a refresh writes and what nothing else does.
    // A single appended character, a trailing space, a continuation row: none of them match, and
    // all of them are written as readline wrote them.
    const painting = line !== '' && text === `${prompt}${line}`;

    return write(painting ? `${prompt}${highlight(line, palette)}` : text);
  };

  let scheduled = false;
  server.input.on('keypress', () => {
    // After readline has finished with this same keypress — refreshing under it would be undone.
    // At most once a tick: a paste arrives as one chunk and readline reads a keypress per
    // character, so without this a hundred-character paste repaints the line a hundred times.
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      // Nothing to paint on an empty line, and a redraw of one is actively wrong: the keypress
      // that empties the line is Enter, which submits it, and the prompt this would draw belongs
      // to the input just SENT rather than to the next one. It landed in front of the answer —
      // `| undefined` for a block that had finished. Deleting back to empty is readline's own
      // redraw, so nothing is lost by leaving that to it.
      if ((server.line ?? '') !== '') internals._refreshLine();
    });
  });
}
