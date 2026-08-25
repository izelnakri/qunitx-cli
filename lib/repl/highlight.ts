import type { Theme } from './theme.ts';

/** A run of source, and what nvim's treesitter queries would capture it as. */
export interface Token {
  /** Index of the first character. */
  start: number;
  /** Index after the last character. */
  end: number;
  /** An nvim capture name — `@keyword.return`, `@string`, `@punctuation.bracket`. */
  capture: string;
}

const ESCAPE = String.fromCharCode(27);
const RESET = `${ESCAPE}[0m`;

// Grouped the way nvim's own queries group them, so a theme written for an editor means the same
// thing here. `@keyword` catches everything without a more specific home.
const KEYWORDS: Readonly<Record<string, string>> = {
  function: '@keyword.function',
  return: '@keyword.return',
  if: '@keyword.conditional',
  else: '@keyword.conditional',
  switch: '@keyword.conditional',
  case: '@keyword.conditional',
  for: '@keyword.repeat',
  while: '@keyword.repeat',
  do: '@keyword.repeat',
  break: '@keyword.repeat',
  continue: '@keyword.repeat',
  typeof: '@keyword.operator',
  instanceof: '@keyword.operator',
  in: '@keyword.operator',
  of: '@keyword.operator',
  void: '@keyword.operator',
  delete: '@keyword.operator',
  import: '@keyword.import',
  export: '@keyword.import',
  from: '@keyword.import',
  as: '@keyword.import',
  try: '@keyword.exception',
  catch: '@keyword.exception',
  finally: '@keyword.exception',
  throw: '@keyword.exception',
  async: '@keyword.coroutine',
  await: '@keyword.coroutine',
  const: '@keyword',
  let: '@keyword',
  var: '@keyword',
  class: '@keyword',
  new: '@keyword',
  extends: '@keyword',
  static: '@keyword',
  get: '@keyword',
  set: '@keyword',
  yield: '@keyword',
  debugger: '@keyword',
  default: '@keyword',
  with: '@keyword',
};

const CONSTANTS = new Set(['null', 'undefined', 'NaN', 'Infinity']);
const BUILTIN_VARIABLES = new Set(['this', 'super', 'globalThis', 'arguments']);
const OPENING = '([{';
const CLOSING = ')]}';
const IDENTIFIER_START = /[\p{ID_Start}_$]/u;
const IDENTIFIER_PART = /[\p{ID_Continue}$]/u;

/**
 * Source as the terminal should draw it: every token wrapped in its capture's style.
 *
 * Unstyled captures are written as they are rather than wrapped in a no-op sequence, so a plainly
 * themed line costs no bytes and a piped session stays comparable text.
 *
 * ```ts
 * import { highlight } from './highlight.ts';
 * import { theme } from './theme.ts';
 *
 * highlight('const a = 1', theme()).includes('const'); // true — painted, not replaced
 * highlight('const a = 1', { style: () => '' }); // 'const a = 1' — an unstyled theme changes nothing
 * ```
 */
export function highlight(source: string, palette: Theme): string {
  let painted = '';
  let at = 0;
  for (const token of tokenize(source)) {
    const style = palette.style(token.capture);
    const text = source.slice(token.start, token.end);
    painted += source.slice(at, token.start) + (style === '' ? text : `${style}${text}${RESET}`);
    at = token.end;
  }

  return painted + source.slice(at);
}

/**
 * How many brackets are open at the end of the source — what a continuation prompt counts.
 *
 * Counted from tokens rather than characters, so a brace inside a string or a comment is text and
 * not a level: `'{'` leaves you exactly where you were.
 *
 * ```ts
 * import { depth } from './highlight.ts';
 *
 * depth('const a = {'); // 1
 * depth('const a = { b: [');  // 2
 * depth("const a = { b: '}' "); // 1 — the brace in the string is not a brace
 * ```
 */
export function depth(source: string): number {
  let open = 0;
  for (const token of tokenize(source)) {
    if (token.capture !== '@punctuation.bracket') continue;
    open += OPENING.includes(source[token.start] as string) ? 1 : -1;
  }

  return Math.max(0, open);
}

/**
 * The source, split into what nvim would capture.
 *
 * A scanner rather than a parser: this runs on every keystroke, and the questions it answers —
 * what colour is this, is that brace real, am I inside a string — need lexing and nothing more.
 * Identifiers are classified by the character either side, which is how a function call is told
 * from a variable and a property from a name.
 *
 * A regex literal is recognised by what precedes it, the same heuristic every syntax highlighter
 * uses, because `/` is division or a literal depending on where it appears. Nothing here is
 * type-aware, so a capitalised name is `@type` — the convention, not the truth.
 *
 * ```ts
 * import { tokenize } from './highlight.ts';
 *
 * tokenize('a.b')[1]?.capture; // '@property' — after a dot
 * tokenize('a(1)')[0]?.capture; // '@function.call' — before a bracket
 * ```
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  // The last token that decides how the NEXT one reads: a dot makes a property, `new` makes a
  // constructor, and a value before a slash makes it division rather than a regular expression.
  let previous: Token | undefined;
  const push = (end: number, capture: string, start: number) => {
    previous = { start, end, capture };
    tokens.push(previous);
  };

  while (at < source.length) {
    const character = source[at] as string;
    if (/\s/.test(character)) {
      at += 1;
      continue;
    }
    const start = at;

    if (character === '/' && source[at + 1] === '/') {
      at = endOfLine(source, at);
      push(at, '@comment', start);
    } else if (character === '/' && source[at + 1] === '*') {
      const closed = source.indexOf('*/', at + 2);
      at = closed === -1 ? source.length : closed + 2;
      push(at, '@comment', start);
    } else if (character === '/' && startsValue(previous, source)) {
      at = endOfRegex(source, at);
      push(at, '@string.regexp', start);
    } else if (character === "'" || character === '"') {
      at = endOfQuoted(source, at, character);
      push(at, '@string', start);
    } else if (character === '`') {
      // Pushes its own tokens: a template is a string with code in the middle of it, and the
      // pieces interleave rather than nest.
      at = endOfTemplate(source, at, tokens);
      previous = tokens.at(-1);
    } else if (
      /[0-9]/.test(character) ||
      (character === '.' && /[0-9]/.test(source[at + 1] ?? ''))
    ) {
      at = endOfNumber(source, at);
      push(at, '@number', start);
    } else if (IDENTIFIER_START.test(character)) {
      while (at < source.length && IDENTIFIER_PART.test(source[at] as string)) at += 1;
      push(at, word(source.slice(start, at), previous, source, at), start);
    } else if (OPENING.includes(character) || CLOSING.includes(character)) {
      at += 1;
      push(at, '@punctuation.bracket', start);
    } else if (',;:'.includes(character)) {
      at += 1;
      push(at, '@punctuation.delimiter', start);
    } else if (character === '.') {
      at += 1;
      push(at, '@punctuation.delimiter', start);
    } else {
      at += 1;
      push(at, '@operator', start);
    }
  }

  return tokens;
}

/** What an identifier is, given what surrounds it. */
function word(text: string, previous: Token | undefined, source: string, end: number): string {
  // A property is whatever follows a dot, whatever it is called — `a.new` is a property, not a
  // keyword, and `a.length` is not a variable.
  if (previous?.capture === '@punctuation.delimiter' && source[previous.start] === '.') {
    return called(source, end) ? '@function.method.call' : '@property';
  }
  const keyword = KEYWORDS[text];
  if (keyword) return keyword;
  if (text === 'true' || text === 'false') return '@boolean';
  if (CONSTANTS.has(text)) return '@constant.builtin';
  if (BUILTIN_VARIABLES.has(text)) return '@variable.builtin';
  if (previous && source.slice(previous.start, previous.end) === 'new') return '@constructor';
  if (called(source, end)) return '@function.call';
  // The convention, not the truth: nothing here knows what a name refers to, and a capitalised
  // one is a type or a constructor often enough to be worth colouring as one.
  if (text[0] === text[0]?.toUpperCase() && text[0] !== text[0]?.toLowerCase()) return '@type';

  return '@variable';
}

/** Whether the next thing after `at` is a call. */
function called(source: string, at: number): boolean {
  let index = at;
  while (index < source.length && /\s/.test(source[index] as string)) index += 1;

  return source[index] === '(';
}

/**
 * Whether a `/` here opens a regular expression rather than dividing.
 *
 * The standard heuristic: division follows a VALUE, so anything else — an operator, an opening
 * bracket, the start of the line — begins a literal. A keyword counts as "anything else" except
 * for `this` and `super`, which are values.
 */
function startsValue(previous: Token | undefined, source: string): boolean {
  if (!previous) return true;
  if (previous.capture === '@punctuation.bracket') {
    return OPENING.includes(source[previous.start] as string);
  }
  const value =
    previous.capture.startsWith('@keyword') === false &&
    ['@variable', '@property', '@number', '@string', '@boolean', '@constant.builtin'].some(
      (capture) => previous.capture.startsWith(capture),
    );

  return !value && previous.capture !== '@variable.builtin';
}

function endOfLine(source: string, at: number): number {
  const newline = source.indexOf('\n', at);

  return newline === -1 ? source.length : newline;
}

function endOfQuoted(source: string, at: number, quote: string): number {
  let index = at + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') index += 2;
    else if (character === quote) return index + 1;
    else index += 1;
  }

  return source.length;
}

/**
 * The end of a template literal, tokenizing the `${…}` inside it as the code it is.
 *
 * Pushed onto the same list rather than nested, so the caller sees one flat sequence — the
 * expression's tokens land between the two string tokens that surround them, which is exactly
 * where they are on screen.
 */
function endOfTemplate(source: string, at: number, tokens: Token[]): number {
  let chunk = at;
  let index = at + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      index += 2;
    } else if (character === '`') {
      tokens.push({ start: chunk, end: index + 1, capture: '@string' });

      return index + 1;
    } else if (character === '$' && source[index + 1] === '{') {
      const closed = matchingBrace(source, index + 1);
      tokens.push({ start: chunk, end: index + 2, capture: '@string' });
      for (const inner of tokenize(source.slice(index + 2, closed))) {
        tokens.push({
          start: inner.start + index + 2,
          end: inner.end + index + 2,
          capture: inner.capture,
        });
      }
      if (closed >= source.length) return source.length;
      // The closing brace begins the next chunk of string.
      chunk = closed;
      index = closed + 1;
    } else {
      index += 1;
    }
  }
  tokens.push({ start: chunk, end: source.length, capture: '@string' });

  return source.length;
}

/** The index just past the `}` that closes the `{` at `at`, or the end of the source. */
function matchingBrace(source: string, at: number): number {
  let open = 0;
  for (let index = at; index < source.length; index += 1) {
    if (source[index] === '{') open += 1;
    else if (source[index] === '}' && --open === 0) return index;
  }

  return source.length;
}

function endOfNumber(source: string, at: number): number {
  let index = at;
  while (index < source.length && /[0-9a-zA-Z_.]/.test(source[index] as string)) index += 1;

  return index;
}

/** The end of a regular expression literal, character class included. */
function endOfRegex(source: string, at: number): number {
  let index = at + 1;
  let inClass = false;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') index += 2;
    else if (character === '[') ((inClass = true), (index += 1));
    else if (character === ']') ((inClass = false), (index += 1));
    else if (character === '/' && !inClass) {
      index += 1;
      // Flags belong to the literal.
      while (index < source.length && /[a-z]/.test(source[index] as string)) index += 1;

      return index;
    } else if (character === '\n') return index;
    else index += 1;
  }

  return source.length;
}
