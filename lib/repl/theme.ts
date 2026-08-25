import process from 'node:process';

/**
 * A palette, keyed by the capture names nvim's treesitter highlighting uses.
 *
 * `@keyword.return`, `@string.escape`, `@punctuation.bracket` — the same names, so a theme can be
 * transcribed from an nvim config without translating anything, and so the fallback works the way
 * nvim's does: a capture with no style of its own inherits its parent's, `@keyword.return` from
 * `@keyword`, all the way up.
 *
 * ```ts
 * import { theme } from './theme.ts';
 *
 * const palette = theme();
 * palette.style('@keyword.return') === palette.style('@keyword'); // true — inherited
 * palette.style('@variable'); // '' — no style is a style, and it means the terminal's own colour
 * ```
 */
export interface Theme {
  /** The SGR prefix for a capture, or `''` where it and its parents have no style. */
  style(capture: string): string;
}

/**
 * The default palette, in the terminal's OWN sixteen colours.
 *
 * Deliberately not hex: `fg=yellow` is whatever yellow the developer's terminal theme says it is,
 * so the prompt matches the shell it was opened from without anybody configuring anything. A theme
 * that wants exact colours can still give them — `fg=#e5c07b` works — but the default should not
 * pick a shade of yellow on behalf of somebody whose terminal already has one.
 *
 * Types keep the colours the REPL prints values in, because they are the same values: strings
 * yellow, numbers cyan, booleans red like the keywords they are. Groups sharing a colour do so
 * because they are the same KIND of thing, never to save a colour.
 */
const DEFAULTS: Readonly<Record<string, string>> = {
  '@comment': 'fg=bright-black',
  '@string': 'fg=yellow',
  '@string.escape': 'fg=magenta',
  '@number': 'fg=cyan',
  '@boolean': 'fg=red',
  '@constant.builtin': 'fg=red',
  '@variable.builtin': 'fg=red',
  '@keyword': 'fg=red',
  '@function': 'fg=blue',
  '@constructor': 'fg=magenta',
  '@type': 'fg=magenta',
  // Named so a theme can colour them, unstyled so a prompt is not a paint chart. Most of a line is
  // variables, properties and punctuation, and colouring those leaves nothing standing out.
  '@variable': '',
  '@property': '',
  '@operator': '',
  '@punctuation': '',
};

/** What the environment calls a theme. One variable, because a REPL has no config file. */
const THEME_VARIABLE = 'QUNITX_REPL_THEME';

const ESCAPE = String.fromCharCode(27);

/**
 * The palette to draw with: the defaults, with anything the developer has set on top.
 *
 * `QUNITX_REPL_THEME='@string=fg=green @keyword=fg=magenta,bold'` — entries separated by spaces,
 * the style spelled the way zsh and nvim both spell it, so a value copied from either works.
 *
 * ```ts
 * import { theme } from './theme.ts';
 *
 * theme().style('@string').endsWith('[33m'); // true — yellow, as the terminal defines yellow
 * ```
 */
export function theme(): Theme {
  const configured = parse(process.env[THEME_VARIABLE]);
  const resolved = new Map<string, string>();

  return {
    style(capture) {
      const cached = resolved.get(capture);
      if (cached !== undefined) return cached;

      // Up the dotted hierarchy, exactly as nvim resolves a capture with no highlight of its own:
      // `@keyword.return` to `@keyword`, `@punctuation.bracket` to `@punctuation`.
      let name = capture;
      for (;;) {
        const spec = configured[name] ?? DEFAULTS[name];
        if (spec !== undefined) {
          const style = ansiStyle(spec);
          resolved.set(capture, style);

          return style;
        }
        const parent = name.lastIndexOf('.');
        if (parent === -1) break;
        name = name.slice(0, parent);
      }
      resolved.set(capture, '');

      return '';
    },
  };
}

/**
 * One style spec as an SGR prefix — `fg=yellow`, `fg=8`, `fg=#e5c07b`, `fg=red,bold`.
 *
 * The three colour spellings are the three that turn up in the wild: a name, which the terminal
 * resolves against its own theme; a 256-colour index; and a truecolour triple. Anything it cannot
 * read styles nothing, because a prompt that refuses to draw over a typo in an environment
 * variable is worse than one that draws plainly.
 *
 * ```ts
 * import { ansiStyle } from './theme.ts';
 *
 * ansiStyle('fg=yellow').endsWith('[33m'); // true
 * ansiStyle('fg=#585858').endsWith('[38;2;88;88;88m'); // true
 * ansiStyle('nonsense'); // '' — unreadable is unstyled
 * ```
 */
export function ansiStyle(spec: string): string {
  const codes: number[] = [];
  for (const part of spec.split(',')) {
    const modifier = MODIFIERS[part.trim()];
    if (modifier) codes.push(modifier);
  }

  const colour = /fg=(#?[0-9a-zA-Z-]+)/.exec(spec)?.[1];
  const named = colour === undefined ? undefined : COLOURS[colour];
  if (named !== undefined) codes.push(named);
  else if (colour !== undefined && /^\d{1,3}$/.test(colour)) codes.push(38, 5, Number(colour));
  else if (colour !== undefined && /^#[0-9a-fA-F]{6}$/.test(colour)) {
    codes.push(38, 2, ...[1, 3, 5].map((at) => parseInt(colour.slice(at, at + 2), 16)));
  }

  return codes.length === 0 ? '' : `${ESCAPE}[${codes.join(';')}m`;
}

const MODIFIERS: Readonly<Record<string, number>> = {
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
};

const COLOURS: Readonly<Record<string, number>> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  'bright-black': 90,
  'bright-red': 91,
  'bright-green': 92,
  'bright-yellow': 93,
  'bright-blue': 94,
  'bright-magenta': 95,
  'bright-cyan': 96,
  'bright-white': 97,
};

/** `@string=fg=green @keyword=fg=red,bold` as a lookup. Anything unreadable is skipped. */
function parse(configured: string | undefined): Record<string, string> {
  const styles: Record<string, string> = {};
  for (const entry of (configured ?? '').split(/\s+/)) {
    const at = entry.indexOf('=');
    if (at > 0) styles[entry.slice(0, at)] = entry.slice(at + 1);
  }

  return styles;
}
