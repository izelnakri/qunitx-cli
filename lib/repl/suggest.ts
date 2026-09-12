/** A name and a path: `document.qu` is `qu` hanging off `document`, `doc` is `doc` off nothing. */
export interface Typed {
  /**
   * The expression whose properties could finish the token, or `''` for a bare name.
   *
   * Only ever a dotted path of plain identifiers. Anything else — `foo().bar`, `list[0].`, a
   * string in mid-flight — is not a base and this reports no completion at all, because the base
   * has to be EVALUATED to find out what is on it, and a keystroke is no reason to run somebody's
   * function call.
   */
  base: string;
  /** The partial identifier under the cursor, empty directly after a dot. */
  token: string;
}

/** What a suggestion can be drawn from. Both are optional: either alone still answers. */
export interface Sources {
  /** Identifiers the page has on {@link Typed.base}, in any order. */
  names?: readonly string[];
  /** Lines already entered, newest first — readline's own record. */
  history?: readonly string[];
}

const IDENTIFIER = /^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u;
const IDENTIFIER_CHARACTER = /[\p{ID_Continue}$]/u;

// Only the ones long enough to be worth finishing. `if`, `new` and `for` are typed faster than a
// suggestion for them can be read, and offering them turns every third keystroke into a flicker.
const KEYWORDS: readonly string[] = [
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'export',
  'extends',
  'finally',
  'function',
  'import',
  'instanceof',
  'return',
  'static',
  'super',
  'switch',
  'throw',
  'typeof',
  'while',
  'yield',
];

/**
 * The rest of what is being typed, drawn after the cursor — zsh's autosuggestion.
 *
 * Names before history, and the SHORTEST name first. `doc` means `document` far more often than it
 * means the last thing you happened to do to `document`, and a suggestion that jumps straight to
 * `document.title` is one you have to delete back to the part you wanted. Once `document` is
 * taken, history extends it — the two sources hand off rather than compete.
 *
 * Keywords only where a page name did not match and at least three characters are in — so `con`
 * still finishes as `console` rather than `const`, and a lone `d` is not `delete`.
 *
 * Returns only the REMAINDER, so a caller can render it after the cursor without measuring
 * anything. Empty when nothing matches, when the line is empty, or when the only match is what is
 * already typed — suggesting that is noise.
 *
 * ```ts
 * import { suggest } from './suggest.ts';
 *
 * suggest('doc', { names: ['document', 'documentPictureInPicture'] }); // 'ument'
 * suggest('doc', { history: ['document.title'] }); // 'ument.title' — nothing better on offer
 * suggest('document', { names: ['document'], history: ['document.title'] }); // '.title'
 * suggest('', { history: ['anything'] }); // '' — an empty line suggests nothing
 * ```
 */
export function suggest(line: string, sources: Sources): string {
  if (line === '') return '';

  const typed = split(line);
  if (typed) {
    const history = sources.history ?? [];
    const named = shortest(typed.token, sources.names ?? [], history);
    if (named !== '') return named;
    // Keywords are top-level words — `document.func` is a property, whatever it is not — and only
    // once enough has been typed to mean one. A single `d` has a dozen keywords under it and no
    // reason to prefer any, where three characters is somebody spelling a word out.
    if (typed.base === '' && typed.token.length >= 3) {
      const keyword = shortest(typed.token, KEYWORDS, history);
      if (keyword !== '') return keyword;
    }
  }
  // Newest first, stopping at the first hit: history only grows, this runs on every keystroke, and
  // the last thing you did is the thing you meant.
  for (const entry of sources.history ?? []) {
    if (entry.length > line.length && entry.startsWith(line)) return entry.slice(line.length);
  }

  return '';
}

/**
 * Where a completion would go in `line`, or `null` where none could.
 *
 * The base is what makes this worth separating from the matching: it decides whether the page gets
 * asked at all, and it deliberately refuses anything that is not a plain dotted path.
 *
 * ```ts
 * import { split } from './suggest.ts';
 *
 * split('1 + document.ti'); // { base: 'document', token: 'ti' }
 * split('document.'); // { base: 'document', token: '' } — everything on it
 * split('foo().b'); // null — finding out what `foo()` returns means calling it
 * split('const x = '); // null — a name has to have started
 * split("alert('he"); // null — inside a string, where `he` is text and not a name
 * ```
 */
export function split(line: string): Typed | null {
  if (insideString(line)) return null;
  let start = line.length;
  while (start > 0 && IDENTIFIER_CHARACTER.test(line[start - 1] as string)) start--;
  const token = line.slice(start);
  // A number is not a name being typed, and `1.` is not a base.
  if (token !== '' && !IDENTIFIER.test(token)) return null;

  const dotted = start > 0 && line[start - 1] === '.';
  // Nothing typed and no dot to hang it off: every name in scope "matches", which is not an offer.
  if (token === '' && !dotted) return null;
  if (!dotted) return { base: '', token };

  let baseStart = start - 1;
  while (baseStart > 0 && /[\p{ID_Continue}$.]/u.test(line[baseStart - 1] as string)) baseStart--;
  const base = line.slice(baseStart, start - 1);
  // Every segment a plain identifier, or this is not a path and nothing is safe to evaluate.
  if (base === '' || !base.split('.').every((segment) => IDENTIFIER.test(segment))) return null;

  return { base, token };
}

/**
 * Whether the line ends inside a string literal, where what is being typed is TEXT.
 *
 * Without this, `document.querySelector('#b` offers `break` — a keyword, matched against the
 * contents of a string. There is no parser here and none is wanted on a keystroke: quotes and
 * their escapes, with a stack for the `${…}` that suspends a template. What it does not model —
 * a regex literal, a comment — costs a suggestion, never a wrong one, because everything it is
 * unsure of falls through to history.
 */
function insideString(line: string): boolean {
  const quotes: string[] = [];
  for (let index = 0; index < line.length; index++) {
    const character = line[index] as string;
    const open = quotes.at(-1);
    if (open === undefined) {
      if (character === "'" || character === '"' || character === '`') quotes.push(character);
    } else if (character === '\\') {
      index++;
    } else if (character === open) {
      quotes.pop();
    } else if (open === '`' && character === '$' && line[index + 1] === '{') {
      // A template's expression is code again, until the brace that ends it.
      quotes.push('}');
      index++;
    } else if (open === '}' && character === '}') {
      quotes.pop();
    } else if (open === '}' && (character === "'" || character === '"' || character === '`')) {
      quotes.push(character);
    }
  }

  return quotes.at(-1) !== undefined && quotes.at(-1) !== '}';
}

/** The shortest candidate that continues `token`, as the part still to type. */
function shortest(
  token: string,
  candidates: readonly string[],
  history: readonly string[],
): string {
  let best = '';
  for (const candidate of candidates) {
    if (candidate.length <= token.length || !candidate.startsWith(token)) continue;
    if (best === '' || beats(candidate, best, history)) best = candidate;
  }

  return best === '' ? '' : best.slice(token.length);
}

/**
 * Shorter wins; an exact tie goes to the name you have used, and failing that to the alphabet.
 *
 * `console` and `confirm` are both seven characters, and only one of them is what anybody typing
 * `con` at a prompt meant. History is the evidence — it costs a scan, but only between candidates
 * that are already the same length, which is rare enough not to be a per-keystroke cost.
 */
function beats(candidate: string, best: string, history: readonly string[]): boolean {
  if (candidate.length !== best.length) return candidate.length < best.length;
  const used = (name: string) =>
    history.some(
      (entry) =>
        entry.startsWith(name) && !IDENTIFIER_CHARACTER.test(entry.charAt(name.length) || ' '),
    );
  const usedCandidate = used(candidate);
  if (usedCandidate !== used(best)) return usedCandidate;

  return candidate < best;
}
