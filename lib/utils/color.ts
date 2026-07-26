/**
 * Minimal ANSI color helpers. Respects NO_COLOR, NODE_DISABLE_COLORS, FORCE_COLOR, and TTY
 * detection — same logic as kleur.
 *
 * Use `createColors(enabled)` in tests to exercise both enabled and disabled branches directly.
 */

/**
 * The chain object a zero-argument `magenta()` call returns.
 *
 * ```ts
 * const chain = magenta(); // MagentaReturn
 * chain.bold('Test Suite'); // bold magenta when color is enabled; plain text otherwise
 * ```
 */
interface MagentaReturn {
  bold: (boldText: string) => string;
}

interface MagentaFn {
  (text: string): string;
  (): MagentaReturn;
}

/**
 * Creates a set of ANSI color helpers with coloring enabled or disabled.
 *
 * ```ts
 * createColors(true).green('pass'); // '\x1b[32mpass\x1b[39m'
 * createColors(false).green('pass'); // 'pass' — disabled branch passes text through
 * ```
 */
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

/**
 * ANSI red text.
 *
 * ```ts
 * red('not ok 1'); // '\x1b[31mnot ok 1\x1b[39m' when color is enabled; 'not ok 1' otherwise
 * ```
 */
export function red(text: string): string {
  return colors.red(text);
}
/**
 * ANSI green text.
 *
 * ```ts
 * green('ok 1'); // '\x1b[32mok 1\x1b[39m' when color is enabled; 'ok 1' otherwise
 * ```
 */
export function green(text: string): string {
  return colors.green(text);
}
/**
 * ANSI yellow text.
 *
 * ```ts
 * yellow('# skip'); // '\x1b[33m# skip\x1b[39m' when color is enabled; '# skip' otherwise
 * ```
 */
export function yellow(text: string): string {
  return colors.yellow(text);
}
/**
 * ANSI blue text.
 *
 * ```ts
 * blue('# todo'); // '\x1b[34m# todo\x1b[39m' when color is enabled; '# todo' otherwise
 * ```
 */
export function blue(text: string): string {
  return colors.blue(text);
}
/**
 * ANSI magenta text. Call without arguments to chain: `magenta().bold(text)`.
 *
 * ```ts
 * magenta('qunitx'); // '\x1b[35mqunitx\x1b[39m' when color is enabled; 'qunitx' otherwise
 * magenta().bold('qunitx'); // bold magenta via the chain form
 * ```
 */
export function magenta(text: string): string;
/** ANSI magenta text. Call without arguments to chain: `magenta().bold(text)`. */
export function magenta(): MagentaReturn;
export function magenta(text?: string): string | MagentaReturn {
  return colors.magenta(text as string);
}
