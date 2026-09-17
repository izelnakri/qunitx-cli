/**
 * The character every terminal control sequence begins with.
 *
 * ```ts
 * import { ESCAPE } from './terminal.ts';
 *
 * ESCAPE.charCodeAt(0); // 27 — written this way because a literal one is what linters refuse
 * ```
 */
export const ESCAPE = String.fromCharCode(27);

const RESET = `${ESCAPE}[0m`;
const ELLIPSIS = '…';

/**
 * The text with its colour taken off — what the terminal would show on a screen with none.
 *
 * Split on the escape rather than matched with a pattern: a regular expression for this needs a
 * literal control character in it, which every linter with an opinion about control characters
 * objects to, and it would be slower besides.
 *
 * ```ts
 * import { plain } from './terminal.ts';
 *
 * plain(`${String.fromCharCode(27)}[33mhi${String.fromCharCode(27)}[0m`); // 'hi'
 * ```
 */
export function plain(text: string): string {
  if (!text.includes(ESCAPE)) return text;

  return text
    .split(ESCAPE)
    .map((part, index) => (index === 0 ? part : part.slice(part.indexOf('m') + 1)))
    .join('');
}

/**
 * Width as the terminal sees it — colour codes take columns nowhere but in the string.
 *
 * ```ts
 * import { plainLength } from './terminal.ts';
 *
 * plainLength('hi'); // 2
 * plainLength(`${String.fromCharCode(27)}[33mhi${String.fromCharCode(27)}[0m`); // 2 — colour is free
 * ```
 */
export function plainLength(text: string): number {
  return plain(text).length;
}

/**
 * Cuts a line to `width` columns, counting what the terminal counts.
 *
 * The reset goes back on the end, so a value cut off mid-colour cannot leak its palette into
 * whatever the terminal draws next.
 *
 * ```ts
 * import { truncate } from './terminal.ts';
 *
 * truncate('abcdef', 4); // 'abc…'
 * truncate('abc', 10); // 'abc' — what already fits is left alone
 * ```
 */
export function truncate(text: string, width: number): string {
  if (width <= 0 || plainLength(text) <= width) return text;

  let kept = '';
  let columns = 0;
  let index = 0;
  while (index < text.length && columns < width - 1) {
    if (text[index] !== ESCAPE) {
      kept += text[index++];
      columns += 1;
      continue;
    }
    // A colour code costs no columns, so it is copied whole and does not count towards the width.
    const end = text.indexOf('m', index);
    if (end === -1) break;
    kept += text.slice(index, end + 1);
    index = end + 1;
  }

  return `${kept}${ELLIPSIS}${RESET}`;
}

/**
 * Text in a style the caller was HANDED, or the text alone where that style is empty.
 *
 * This is the themed half of a two-vocabulary split, and the split is the whole point:
 *
 *   - `red('No such frame')` — `lib/utils/color.ts`, a FIXED colour chosen at the call site. The
 *     tool speaking in its own voice: errors, warnings, notices. Not themeable, because an error
 *     is red in every terminal and nobody wants to configure that.
 *   - `inStyle(name, palette.style('@function'))` — a colour chosen by the DEVELOPER, in their
 *     `QUNITX_REPL_THEME`. The page's content being shown back: a value, a path, an identifier.
 *
 * `red()` cannot do this job, and it is worth being precise about why rather than assuming it is
 * only taste. Three reasons, each load-bearing:
 *
 * 1. **The style is data.** A capture name arrives from the PAGE — `.imported` asks it what kind
 *    each export is and gets back `@function`, `@string`, `@type`. There is no `colors[capture]`
 *    to call; the palette resolves it, and this puts the answer on.
 * 2. **An empty style must cost zero bytes.** Half the default theme is deliberately unstyled
 *    (`@variable`, `@property`, `@punctuation` — a prompt is not a paint chart), and a piped or
 *    `NO_COLOR` session makes ALL of it empty. `red()` shortens to the bare text too, but only
 *    for its own fixed colour; this has to hold for a style it is only told about.
 * 3. **It is half a system.** What goes in here comes back out through {@link plain},
 *    {@link plainLength} and {@link truncate} — a line laid out in columns has to be measured
 *    without its escapes and cut without losing the reset. That contract lives in this module, so
 *    the function that WRITES the escapes belongs here too.
 *
 * ```ts
 * import { inStyle } from './terminal.ts';
 * import { theme } from './theme.ts';
 *
 * const palette = theme(true);
 *
 * // Themed: what the page holds, in the colour the developer picked for it.
 * inStyle('GREETING', palette.style('@string')); // yellow by default, green if they said so
 *
 * // An unstyled capture is the terminal's own colour, and costs nothing to say so.
 * inStyle('answer', palette.style('@variable')); // 'answer' — no escapes at all
 * inStyle('answer', theme(false).style('@string')); // 'answer' — a pipe gets plain text
 *
 * // Whatever it wraps, it closes — so a cut line cannot leak its colour onto the next one.
 * inStyle('hi', palette.style('@string')).endsWith(`${String.fromCharCode(27)}[0m`); // true
 * ```
 */
export function inStyle(text: string, style: string): string {
  return style === '' ? text : `${style}${text}${RESET}`;
}

/**
 * How wide a line may be. 80 where nothing says — a pipe has no width, and neither does a file.
 *
 * ```ts
 * import { terminalWidth } from './terminal.ts';
 *
 * terminalWidth({ write: () => true } as never); // 80 — nothing there to ask
 * ```
 */
export function terminalWidth(output: NodeJS.WritableStream): number {
  return (output as NodeJS.WriteStream).columns || 80;
}

/**
 * Clears the visible screen and leaves the scrollback alone.
 *
 * `[2J` erases what is on screen; `[3J` would erase what has scrolled off it, which is the
 * difference between clearing a terminal and losing the last hour of it. Only the first is sent,
 * which is why scrolling still works afterwards — and which is what readline already does for
 * Ctrl-L, so that key needs nothing from us.
 *
 * ```ts
 * import { clearScreen } from './terminal.ts';
 *
 * clearScreen().includes('[3J'); // false — the scrollback is not ours to throw away
 * ```
 */
export function clearScreen(): string {
  return `${ESCAPE}[H${ESCAPE}[2J`;
}
