import process from 'node:process';
import { colorEnabled } from '../utils/color.ts';

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
 * palette.painter('@keyword.return') === palette.painter('@keyword'); // true — inherited
 * palette.painter('@variable')('x'); // 'x' — no style is a style: the terminal's own colour
 * ```
 */
export interface Theme {
  /**
   * The function that paints text in a capture's colour — kleur's shape, one function per colour.
   *
   * `palette.painter('@string')('hi')` rather than a prefix you then have to wrap text in
   * yourself. It used to hand back the raw SGR sequence, and every single caller did the same
   * thing with it, which is the definition of an implementation detail that leaked.
   *
   * Two colour vocabularies live in this codebase and this is the themed one:
   *
   *   - `red('No such frame')` — `lib/utils/color.ts`, a FIXED colour chosen at the call site.
   *     The tool speaking in its own voice: errors, warnings. Not themeable, because an error is
   *     red in every terminal and nobody wants to configure that.
   *   - `palette.painter('@function')(name)` — a colour chosen by the DEVELOPER in their
   *     `QUNITX_REPL_THEME`. The page's own content shown back: a value, a path, an identifier.
   *     `red()` cannot do this job, because the capture arrives as DATA — `.imported` asks the
   *     page what kind each export is and gets back `@function`, `@string`, `@type`, and there is
   *     no fixed set of functions to name when the set is whatever somebody wrote in an env var.
   *
   * An unstyled capture returns the identity function, so it costs no bytes: half the default
   * theme is deliberately unstyled, and a piped or `NO_COLOR` session makes all of it so. What a
   * painter writes comes back out through `plain`, `plainLength` and `truncate`, which is how a
   * line laid out in columns is measured without its escapes.
   *
   * The same function comes back for the same capture, so the highlighter can ask on every
   * keystroke without allocating.
   */
  painter(capture: string): (text: string) => string;
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
  // Not a capture: nvim's own name for the line-number column, which `.cat` draws one of. A theme
  // has one opinion about gutters and it should not have to give it twice.
  LineNr: 'fg=bright-black',
  // Neither is this: what `ls` and every file tree colour a directory, and what `.tree` needs.
  Directory: 'fg=blue',
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
const RESET = `${ESCAPE}[0m`;

/**
 * The palette to draw with: the defaults, with anything the developer has set on top.
 *
 * `QUNITX_REPL_THEME='@string=fg=green @keyword=fg=magenta,bold'` — entries separated by spaces,
 * the style spelled the way zsh and nvim both spell it, so a value copied from either works.
 *
 * Every style is empty where the session has no colour — piped, redirected, or `NO_COLOR` — so a
 * `.cat` into a file is the file and a scripted session is text a script can compare. `colour`
 * says so outright, for a caller that has already made that decision by other means.
 *
 * ```ts
 * import { theme } from './theme.ts';
 *
 * theme(true).painter('@string')('hi').includes('[33m'); // true — yellow, as the terminal has it
 * theme(false).painter('@string')('hi'); // 'hi' — nothing painted where nothing reads colour
 * ```
 */
export function theme(colour: boolean = colorEnabled): Theme {
  // One shared identity function rather than a fresh one per capture: with no colour there is
  // nothing to tell two captures apart by.
  if (!colour) return { painter: () => asItIs };

  const configured = parse(process.env[THEME_VARIABLE]);
  // Two caches, and the second one is the interesting half: painters are keyed by the COLOUR they
  // came out as, not by the capture that asked. So `@keyword.return`, which inherits `@keyword`,
  // gets back the very same function — identity means "same colour", and a theme with thirty
  // captures and six colours holds six closures.
  const byCapture = new Map<string, (text: string) => string>();
  const byColour = new Map<string, (text: string) => string>();

  return {
    painter(capture) {
      const cached = byCapture.get(capture);
      if (cached !== undefined) return cached;

      const colour = sgrFor(capture, configured);
      const made = byColour.get(colour) ?? paintingIn(colour);
      byColour.set(colour, made);
      byCapture.set(capture, made);

      return made;
    },
  };
}

/** What an unstyled capture paints with, and what every capture paints with on a pipe. */
function asItIs(text: string): string {
  return text;
}

/** Wraps text in a prefix and closes it again, or hands it back untouched where there is none. */
function paintingIn(style: string): (text: string) => string {
  if (style === '') return asItIs;

  return (text) => `${style}${text}${RESET}`;
}

/**
 * A capture's SGR prefix, `''` where neither it nor any parent of it has one.
 *
 * Up the dotted hierarchy, exactly as nvim resolves a capture with no highlight of its own:
 * `@keyword.return` to `@keyword`, `@punctuation.bracket` to `@punctuation`.
 */
function sgrFor(capture: string, configured: Record<string, string>): string {
  let name = capture;
  for (;;) {
    const spec = configured[name] ?? DEFAULTS[name];
    if (spec !== undefined) return ansiStyle(spec);
    const parent = name.lastIndexOf('.');
    if (parent === -1) return '';
    name = name.slice(0, parent);
  }
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
