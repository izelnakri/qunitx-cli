/**
 * Minimal ANSI color helpers. Respects NO_COLOR, NODE_DISABLE_COLORS, FORCE_COLOR, and TTY
 * detection — same logic as kleur.
 *
 * Use `createColors(enabled)` in tests to exercise both enabled and disabled branches directly.
 */

interface MagentaReturn {
  bold: (boldText: string) => string;
}

interface MagentaFn {
  (text: string): string;
  (): MagentaReturn;
}

/** Creates a set of ANSI color helpers with coloring enabled or disabled. */
export function createColors(enabled: boolean) {
  const makeColor = (open: number, close: number) => (text: string) =>
    enabled ? `\x1b[${open}m${text}\x1b[${close}m` : String(text);

  const red = makeColor(31, 39);
  const green = makeColor(32, 39);
  const yellow = makeColor(33, 39);
  const blue = makeColor(34, 39);

  /** `magenta(text)` — colored text. `magenta()` — chainable: `.bold(text)`. */
  const magenta = ((text?: string): string | MagentaReturn => {
    if (text !== undefined) return enabled ? `\x1b[35m${text}\x1b[39m` : String(text);
    return {
      bold: (boldText: string) =>
        enabled ? `\x1b[35m\x1b[1m${boldText}\x1b[22m\x1b[39m` : String(boldText),
    };
  }) as MagentaFn;

  return { red, green, yellow, blue, magenta };
}

const enabled =
  !process.env.NODE_DISABLE_COLORS &&
  process.env.NO_COLOR == null &&
  process.env.TERM !== 'dumb' &&
  ((process.env.FORCE_COLOR != null && process.env.FORCE_COLOR !== '0') || !!process.stdout?.isTTY);

const colors = createColors(enabled);

/** ANSI red text. */
export function red(text: string): string {
  return colors.red(text);
}
/** ANSI green text. */
export function green(text: string): string {
  return colors.green(text);
}
/** ANSI yellow text. */
export function yellow(text: string): string {
  return colors.yellow(text);
}
/** ANSI blue text. */
export function blue(text: string): string {
  return colors.blue(text);
}
/** ANSI magenta text. Call without arguments to chain: `magenta().bold(text)`. */
export function magenta(text: string): string;
/** ANSI magenta text. Call without arguments to chain: `magenta().bold(text)`. */
export function magenta(): MagentaReturn;
export function magenta(text?: string): string | MagentaReturn {
  return colors.magenta(text as string);
}
