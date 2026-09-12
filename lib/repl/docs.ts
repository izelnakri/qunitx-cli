import { paint } from './columns.ts';
import { highlight, tokenize } from './highlight.ts';
import type { Theme } from './theme.ts';

const FENCE = /^\s*```/;

/**
 * The comment written directly above a line, with its markers taken off.
 *
 * Directly above, with nothing between: a comment separated from what it describes by a blank
 * line is describing something else. Both spellings, since a codebase has both — a `/** … *\/`
 * block, or a run of `//` lines.
 *
 * ```ts
 * import { commentAbove } from './docs.ts';
 *
 * commentAbove('// what it does\nexport const a = 1;', 2); // ['what it does']
 * commentAbove('const a = 1;\nconst b = 2;', 2); // [] — nothing is being said about it
 * ```
 */
export function commentAbove(source: string, line: number): string[] {
  const lines = source.split('\n');
  let at = line - 2;
  // Past `export`, decorators and the like: the comment sits above the whole declaration.
  while (at >= 0 && /^\s*@/.test(lines[at] ?? '')) at--;
  const last = (lines[at] ?? '').trim();

  if (last.endsWith('*/')) {
    const block: string[] = [];
    for (; at >= 0; at--) {
      const text = (lines[at] ?? '').trim();
      block.unshift(text);
      if (text.startsWith('/*')) break;
    }

    return block
      .map((text) =>
        text
          .replace(/^\/\*+\s?/, '')
          .replace(/\s*\*+\/$/, '')
          .replace(/^\*\s?/, ''),
      )
      .filter((text, index, all) => !(text === '' && (index === 0 || index === all.length - 1)));
  }

  const run: string[] = [];
  for (; at >= 0 && (lines[at] ?? '').trim().startsWith('//'); at--) {
    run.unshift((lines[at] as string).trim().replace(/^\/\/\s?/, ''));
  }

  return run;
}

/**
 * A comment as the prompt should print it: prose muted, and the examples in it read as code.
 *
 * A fenced example is the part anybody scrolls to — it is the one bit of a doc comment that says
 * what to type — so it is painted the way the same code is painted at the prompt rather than
 * greyed out with the sentences around it.
 *
 * ```ts
 * import { renderDoc } from './docs.ts';
 *
 * renderDoc(['what it does'], { style: () => '' }); // 'what it does'
 * renderDoc([], { style: () => '' }); // '' — nothing written is nothing to print
 * ```
 */
export function renderDoc(lines: readonly string[], palette: Theme): string {
  const comment = palette.style('@comment');
  let fenced = false;

  return lines
    .map((text) => {
      if (FENCE.test(text)) {
        fenced = !fenced;

        return paint(text, comment);
      }

      return fenced ? highlight(text, palette) : paint(text, comment);
    })
    .join('\n');
}

/**
 * The declaration a line starts, up to where its body begins.
 *
 * What a signature is FOR is telling you how to call something, so it stops at the `{` — and only
 * at one that opens a body, not one inside a parameter's type or default. Multi-line signatures
 * come back whole, since a parameter list broken over four lines is still one thing to read.
 *
 * ```ts
 * import { signature } from './docs.ts';
 *
 * signature('export function helper(value: number): number {\n  return 1;\n}', 1);
 * // 'export function helper(value: number): number'
 * signature('const a = 1;', 1); // 'const a = 1;' — nothing opens, so it is all of it
 * ```
 */
export function signature(source: string, line: number): string {
  const from = offsetOf(source, line);
  if (from === null) return '';

  let depth = 0;
  for (let at = from; at < source.length; at++) {
    const character = source[at];
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    // The brace that opens the body: the first one that is not inside a parameter list.
    else if (character === '{' && depth <= 0) return tidy(source.slice(from, at));
    else if (character === '\n' && depth <= 0 && /[;=]\s*$/.test(source.slice(from, at))) {
      return tidy(source.slice(from, at));
    }
  }

  return tidy(source.slice(from));
}

/**
 * A whole declaration — its first line through the `}` that closes it.
 *
 * Counted from tokens, so a brace inside a string or a comment in the body does not end it early.
 * A declaration with no body at all is the line it is written on.
 *
 * ```ts
 * import { blockAt } from './docs.ts';
 *
 * blockAt('function a() {\n  return 1;\n}\nconst b = 2;', 1); // 'function a() {\n  return 1;\n}'
 * blockAt('const b = 2;', 1); // 'const b = 2;'
 * ```
 */
export function blockAt(source: string, line: number): string {
  const from = offsetOf(source, line);
  if (from === null) return '';

  const rest = source.slice(from);
  let depth = 0;
  let opened = false;
  for (const token of tokenize(rest)) {
    if (token.capture !== '@punctuation.bracket') continue;
    const character = rest[token.start];
    if (character !== '{' && character !== '}') continue;
    depth += character === '{' ? 1 : -1;
    opened ||= character === '{';
    if (opened && depth === 0) return rest.slice(0, token.end);
  }

  return opened ? rest : (rest.split('\n')[0] as string);
}

/** Where a 1-based line begins, or `null` when the source has no such line. */
function offsetOf(source: string, line: number): number | null {
  if (line < 1) return null;
  let at = 0;
  for (let seen = 1; seen < line; seen++) {
    const next = source.indexOf('\n', at);
    if (next === -1) return null;
    at = next + 1;
  }

  return at <= source.length ? at : null;
}

/** One signature, however many lines it was written over. */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .join(' ')
    .trim();
}
