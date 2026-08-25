import process from 'node:process';
import { highlight, tokenize } from './highlight.ts';
import type { Theme } from './theme.ts';

/** How much source to show around a breakpoint. */
export interface Limits {
  /** Lines before it, at most. It stops sooner at the start of the enclosing block. */
  before: number;
  /** Lines after it, at most. It stops sooner at a `return`. */
  after: number;
}

/**
 * The default window: enough of the way up to see what function you are in, and enough of the way
 * down to see what it is about to answer.
 *
 * Asymmetric on purpose. What comes before a breakpoint is what led to it and is worth several
 * lines; what comes after has not happened yet, and past the `return` it is somebody else's code.
 *
 * ```ts
 * import { LINES } from './excerpt.ts';
 *
 * LINES.before > LINES.after; // true — what led here is worth more lines than what has not run
 * ```
 */
export const LINES: Limits = { before: 6, after: 4 };

/** What the environment calls this, in the spelling the REPL's other settings use. */
const CONTEXT_VARIABLE = 'QUNITX_REPL_CONTEXT';

const ESCAPE = String.fromCharCode(27);
const RESET = `${ESCAPE}[0m`;
const OPENING = '([{';

/**
 * How much to show, with anything the developer has said on top.
 *
 * `QUNITX_REPL_CONTEXT=10` for ten lines before, `10,2` for ten before and two after, `0` for none
 * at all — a breakpoint you already know your way around does not need a map every time.
 *
 * ```ts
 * import { limits } from './excerpt.ts';
 *
 * limits().before >= 0; // true — whatever it reads, it is a count of lines
 * ```
 */
export function limits(): Limits {
  const configured = process.env[CONTEXT_VARIABLE];
  if (configured === undefined) return LINES;
  const [before, after] = configured.split(',').map((part) => Number(part.trim()));
  const asked = (value: number | undefined, fallback: number) =>
    Number.isInteger(value) && (value as number) >= 0 ? (value as number) : fallback;

  // `0` on its own means none: an `after` that was not given follows the `before` that was.
  return {
    before: asked(before, LINES.before),
    after: asked(after, before === 0 ? 0 : LINES.after),
  };
}

/**
 * The source around a breakpoint, numbered, with a mark on the line the page stopped on.
 *
 * ```
 *   3 │ export function inspectMe(): number {
 *   4 │   const answer = 42;
 * > 5 │   debugger;
 *   6 │
 *   7 │   return answer;
 * ```
 *
 * Both edges are found rather than counted to. Going up it stops at the line that OPENS the block
 * the breakpoint is in — the function signature, most of the time — because a window that starts
 * mid-statement tells you less than one that starts where the scope does. Going down it stops at
 * the `return`, since what a function answers is the other half of what you are looking at, and
 * anything past it belongs to a different frame.
 *
 * Where neither is within reach the limits win, and a `return` too far away is not shown at all:
 * one line below is enough to see where you are, and four lines of unrelated body is noise.
 *
 * ```ts
 * import { excerpt } from './excerpt.ts';
 *
 * const plain = { style: () => '' };
 * excerpt('const a = 1;\ndebugger;\n', 2, plain); // '  1 │ const a = 1;\n> 2 │ debugger;'
 * excerpt('', 1, plain); // '' — nothing to show is shown as nothing
 * ```
 */
export function excerpt(
  source: string,
  line: number,
  palette: Theme,
  limits: Limits = LINES,
): string {
  const lines = source.split('\n');
  if (source === '' || line < 1 || line > lines.length || limits.before + limits.after === 0) {
    return '';
  }

  const deltas = bracketDeltas(source, lines);
  const first = openingLine(deltas, line, limits.before);
  const last = closingLine(source, lines, deltas, line, limits.after);
  const gutter = String(last).length;
  const dim = palette.style('LineNr');
  const mark = palette.style('@keyword');

  return lines
    .slice(first - 1, last)
    .map((text, index) => {
      const number = String(first + index).padStart(gutter);
      const here = first + index === line;
      const edge = here
        ? `${paint('>', mark)} ${paint(`${number} │`, mark)}`
        : `  ${paint(`${number} │`, dim)}`;

      return `${edge} ${highlight(text, palette)}`;
    })
    .join('\n');
}

/**
 * The first line to show: up to `before` back, or the line that opens the enclosing block.
 *
 * Counted in brackets rather than in indentation, because indentation is a convention and brackets
 * are the language. Walking back, the first line that leaves more brackets open than it closes is
 * the one that opened the block the breakpoint is inside.
 */
function openingLine(deltas: readonly number[], line: number, before: number): number {
  let open = 0;
  for (let at = line - 1; at >= Math.max(1, line - before); at--) {
    open += deltas[at - 1] ?? 0;
    if (open > 0) return at;
  }

  return Math.max(1, line - before);
}

/**
 * The last line to show: the `return` that ends the frame, or one line, or the limit.
 *
 * A `return` within reach is the end of what you are looking at. Beyond reach it is not worth
 * walking to — one line below the breakpoint says where you are, and three more of unrelated body
 * says nothing.
 */
function closingLine(
  source: string,
  lines: readonly string[],
  deltas: readonly number[],
  line: number,
  after: number,
): number {
  const returns = returningLines(source);
  let open = 0;
  for (let at = line + 1; at <= Math.min(lines.length, line + after); at++) {
    open += deltas[at - 1] ?? 0;
    // The block closed, or the frame answered. Either way this is the last line worth showing.
    if (returns.has(at) || open < 0) return at;
  }

  return Math.min(lines.length, line + (after > 0 ? 1 : 0));
}

/**
 * How many brackets each line leaves open.
 *
 * From ONE pass over the whole source rather than a pass per line, which is what makes a brace
 * inside a string or a template stay text — tokenizing a line on its own cannot know it is in the
 * middle of one.
 */
function bracketDeltas(source: string, lines: readonly string[]): number[] {
  const deltas = new Array<number>(lines.length).fill(0);
  const starts = lineStarts(source);
  for (const token of tokenize(source)) {
    if (token.capture !== '@punctuation.bracket') continue;
    const at = lineOf(starts, token.start);
    deltas[at - 1] =
      (deltas[at - 1] ?? 0) + (OPENING.includes(source[token.start] as string) ? 1 : -1);
  }

  return deltas;
}

/** The lines with a `return` on them — the keyword, not the word inside a string. */
function returningLines(source: string): Set<number> {
  const starts = lineStarts(source);
  const found = new Set<number>();
  for (const token of tokenize(source)) {
    if (token.capture === '@keyword.return') found.add(lineOf(starts, token.start));
  }

  return found;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) {
    starts.push(at + 1);
  }

  return starts;
}

/** The 1-based line an offset falls on, by binary search over where the lines begin. */
function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] as number) <= offset) low = middle;
    else high = middle - 1;
  }

  return low + 1;
}

function paint(text: string, style: string): string {
  return style === '' ? text : `${style}${text}${RESET}`;
}
