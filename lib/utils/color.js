/**
 * Minimal ANSI color helpers. Respects NO_COLOR, NODE_DISABLE_COLORS, FORCE_COLOR, and TTY
 * detection — same logic as kleur.
 *
 * Use `createColors(enabled)` in tests to exercise both enabled and disabled branches directly.
 */

export function createColors(enabled) {
  const c = (open, close) => (text) =>
    enabled ? `\x1b[${open}m${text}\x1b[${close}m` : String(text);

  const red = c(31, 39);
  const green = c(32, 39);
  const yellow = c(33, 39);
  const blue = c(34, 39);

  /** `magenta(text)` — colored text. `magenta()` — chainable: `.bold(text)`. */
  const magenta = (text) => {
    if (text !== undefined) return enabled ? `\x1b[35m${text}\x1b[39m` : String(text);
    return { bold: (t) => (enabled ? `\x1b[35m\x1b[1m${t}\x1b[22m\x1b[39m` : String(t)) };
  };

  return { red, green, yellow, blue, magenta };
}

const enabled =
  !process.env.NODE_DISABLE_COLORS &&
  process.env.NO_COLOR == null &&
  process.env.TERM !== 'dumb' &&
  ((process.env.FORCE_COLOR != null && process.env.FORCE_COLOR !== '0') || !!process.stdout?.isTTY);

const _c = createColors(enabled);

/** ANSI red text. */
export function red(text) {
  return _c.red(text);
}
/** ANSI green text. */
export function green(text) {
  return _c.green(text);
}
/** ANSI yellow text. */
export function yellow(text) {
  return _c.yellow(text);
}
/** ANSI blue text. */
export function blue(text) {
  return _c.blue(text);
}
/** ANSI magenta text. Call without arguments to chain: `magenta().bold(text)`. */
export function magenta(text) {
  return _c.magenta(text);
}
