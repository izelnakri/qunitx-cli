// What one line of typed input has to become before a page can evaluate it, and how to tell
// "you are not finished typing" from "that is not JavaScript". Pure string work, kept apart from
// the session so both decisions can be tested without a browser.

// V8's wording when the parser ran out of input rather than finding something it disliked. The
// distinction is the whole multiline story: the first list means "keep reading", anything else is
// a real syntax error to report now. `Unterminated` covers a string/template/comment left open,
// which V8 reports by name instead of as an end-of-input.
const INCOMPLETE_PATTERNS = [
  /Unexpected end of input/,
  /Unexpected end of script/,
  /Unterminated template literal/,
  /Unterminated comment/,
  /Unterminated string literal/,
];

/**
 * The expressions to try for one line of input, in order.
 *
 * Only `{`-leading input gets two: `{ a: 1 }` is a block containing a labelled statement as a
 * statement and an object as an expression, and a REPL means the object every time — so the
 * parenthesised form is tried first and the bare form is the fallback for input that really was a
 * block. Everything else is itself, unchanged: top-level `await`, `let` redeclaration and the
 * completion value of the last statement are all handled by CDP's REPL mode, so there is nothing
 * left for a source transform to do.
 *
 * ```ts
 * import { candidates } from './source.ts';
 *
 * candidates('1 + 1'); // ['1 + 1']
 * candidates('{ a: 1 }'); // ['({ a: 1 })', '{ a: 1 }'] — object first, block second
 * ```
 */
export function candidates(input: string): string[] {
  const trimmed = input.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return [`(${trimmed})`, trimmed];

  return [trimmed];
}

/**
 * Whether a `SyntaxError` means the input is unfinished rather than wrong.
 *
 * The caller turns a `true` here into another prompt line instead of an error, which is why it
 * reads V8's message rather than counting brackets: `foo(` and `` `abc `` are both open, and only
 * the parser knows which shapes are still completable.
 *
 * ```ts
 * import { isIncomplete } from './source.ts';
 *
 * isIncomplete('SyntaxError: Unexpected end of input'); // true — keep reading
 * isIncomplete("SyntaxError: Unexpected token ';'"); // false — report it
 * ```
 */
export function isIncomplete(description: string): boolean {
  return INCOMPLETE_PATTERNS.some((pattern) => pattern.test(description));
}
