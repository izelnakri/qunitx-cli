import { depth, tokenize } from './highlight.ts';

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

/** A declaration made at a breakpoint: what it binds, to what, and how long it should last. */
export interface Declaration {
  /** The name it binds. */
  name: string;
  /** The expression its value comes from, to be evaluated where the input was typed. */
  value: string;
  /**
   * Whether it belongs to the block it was written in — `let`, `const` and `class` do.
   *
   * What decides its fate when the page carries on: block-scoped names were written inside the
   * block the breakpoint stopped in and go when it does, while `var` and `function` are the ones
   * JavaScript hoists out of blocks and everyone expects to still be there afterwards.
   */
  blockScoped: boolean;
}

/**
 * What a line declares, or `null` where it declares nothing.
 *
 * At a breakpoint the page is evaluated with `Debugger.evaluateOnCallFrame`, which runs each input
 * in a scope of its own and throws that scope away afterwards. A `let` there answers `undefined`
 * like a declaration should and then does not exist, which is the worst of both: it looks like it
 * worked. Knowing the name and the value separately is what lets a caller keep the binding
 * somewhere that lasts while evaluating the VALUE where it was typed — `let doubled = answer * 2`
 * has to see the frame's `answer`, and only the frame can.
 *
 * Only a single name is read. A destructuring pattern or several declarators at once are left
 * alone rather than half-understood, and behave as they did: for the length of one evaluation.
 *
 * ```ts
 * import { declaration } from './source.ts';
 *
 * declaration("let me = { age: 32 }"); // { name: 'me', value: '{ age: 32 }', blockScoped: true }
 * declaration('var a = 1')?.blockScoped; // false — hoisted out of blocks, so it stays
 * declaration('me.age'); // null — nothing is being declared
 * declaration('let a = 1, b = 2'); // null — two at once is left alone rather than half-understood
 * ```
 */
export function declaration(input: string): Declaration | null {
  const trimmed = input.trim();
  // Unfinished input is not a declaration yet: `let a = {` has to be read on, and treating it as
  // one would turn "keep typing" into a syntax error.
  if (trimmed === '' || depth(trimmed) > 0) return null;

  const bound = DECLARATION.exec(trimmed);
  if (bound) {
    const [, keyword = '', name = '', initializer = ''] = bound;
    // `let a = 1, b = 2` binds two names and this reads one, so it declines the whole thing.
    if (topLevelComma(initializer)) return null;

    return { name, value: expression(initializer), blockScoped: BLOCK_SCOPED.has(keyword) };
  }

  const named = NAMED_DEFINITION.exec(trimmed);
  const [, keyword = '', name = ''] = named ?? [];

  // A definition in parentheses is an expression, and a named one keeps its name.
  return name === ''
    ? null
    : { name, value: expression(trimmed), blockScoped: BLOCK_SCOPED.has(keyword) };
}

/** The declarations that belong to the block they are written in, and go when it does. */
const BLOCK_SCOPED = new Set(['let', 'const', 'class']);

const DECLARATION = /^(let|const|var)\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)\s*=([\s\S]+)$/u;
const NAMED_DEFINITION =
  /^(?:async\s+)?(function|class)\b\s*\*?\s*([\p{ID_Start}_$][\p{ID_Continue}$]*)/u;

/** Parenthesised, which is what makes a definition an expression and an object literal not a block. */
function expression(value: string): string {
  return `(${value.trim().replace(/;+$/, '')})`;
}

/** Whether a comma separates declarators rather than sitting inside something. */
function topLevelComma(initializer: string): boolean {
  let open = 0;
  for (const token of tokenize(initializer)) {
    const text = initializer.slice(token.start, token.end);
    if (token.capture === '@punctuation.bracket') open += '([{'.includes(text) ? 1 : -1;
    else if (open === 0 && text === ',') return true;
  }

  return false;
}
