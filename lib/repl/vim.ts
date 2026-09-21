// Vim's normal mode, as a pure function over one line of text.
//
// ENGINE, not terminal: nothing here knows about `node:repl`, readline, escape sequences or a
// screen. One key goes in against `{ text, cursor }`, and a new `{ text, cursor }` comes out —
// which is what makes a grammar with counts, operators, motions and text objects testable by
// typing at it rather than by standing up a pty. Binding it to a real prompt is
// `lib/commands/repl/vim-mode.ts`.
//
// The subset is the one zsh's `vi-mode` settled on, plus text objects, which a prompt full of
// brackets and quotes wants far more than a shell does: `ci"` and `di(` are most of why anybody
// turns this on for a code prompt.

/** Which mode the prompt is in. `insert` types; `normal` is where the grammar below applies. */
export type Mode = 'insert' | 'normal';

/** A line being edited, and where the caret is in it. `cursor` may equal `text.length` in insert. */
export interface Line {
  /** The whole line. */
  text: string;
  /** A character index; `text.length` means "after the last character", which only insert allows. */
  cursor: number;
}

/** Everything normal mode has to remember between keys. */
export interface VimState {
  /** Which mode the prompt is in. */
  mode: Mode;
  /** Keys typed toward a command that is not finished yet — `d`, `2d`, `f`, `di`. */
  pending: string;
  /** The unnamed register: what `x`, `d`, `c` and `y` left behind for `p` and `P`. */
  register: string;
  /**
   * Whether what is in the register was taken LINEWISE — by `dd`, `cc`, `yy` or `Y`.
   *
   * vim puts a linewise register on a new line, and a prompt has none, so here it replaces the
   * whole line instead. That is what makes `ddp` put the line back where `dd` found it rather
   * than splicing it into the middle of whatever is there now.
   */
  registerIsLine: boolean;
  /** Where `u` goes back to, newest last. Bounded, because a prompt is not an editor. */
  undo: Line[];
  /** The keys of the last CHANGE, for `.` to do again. Never a `.` itself. */
  lastChange: string;
  /** The last `f`/`F`/`t`/`T`, so `;` repeats it and `,` reverses it. */
  lastFind: { key: string; char: string } | null;
}

/** What the terminal must do about a key that the line alone cannot express. */
export type VimAction =
  /** Nothing beyond redrawing the line this step returned. */
  | 'none'
  /** Insert mode: hand the key to readline, which owns typing. */
  | 'forward'
  /** Run the line, as Enter does. */
  | 'submit'
  /** The previous history entry — what `k` means here and Ctrl-K means in insert. */
  | 'historyPrev'
  /** The next one, for `j`. */
  | 'historyNext';

/** One key's worth of consequences. */
export interface VimStep {
  /** The state to keep for the next key. */
  state: VimState;
  /** The line as this key left it. */
  line: Line;
  /** What the terminal has to do, beyond drawing {@link VimStep.line}. */
  action: VimAction;
}

/** How many lines `u` can go back through. Deeper than anybody undoes at a prompt, still bounded. */
const UNDO_KEPT = 100;

/** The motions that need no argument. `f`, `t` and their capitals take a character and are apart. */
const BARE_MOTIONS = new Set(['h', 'l', ' ', '0', '^', '$', 'w', 'W', 'b', 'B', 'e', 'E', '|']);

/** The bracket pairs `i(`/`a{` and friends work over, by either of the characters that names them. */
const PAIRS: ReadonlyMap<string, [string, string]> = new Map([
  ['(', ['(', ')']],
  [')', ['(', ')']],
  ['b', ['(', ')']],
  ['[', ['[', ']']],
  [']', ['[', ']']],
  ['{', ['{', '}']],
  ['}', ['{', '}']],
  ['B', ['{', '}']],
  ['<', ['<', '>']],
  ['>', ['<', '>']],
]);

/** The quotes a text object can reach inside. */
const QUOTES = new Set(['"', "'", '`']);

/**
 * A prompt in insert mode, remembering nothing — where a session starts.
 *
 * Insert, not normal, because a prompt you have just been given is one you are about to type at.
 * vim opens a file in normal mode because you are about to NAVIGATE it; nobody navigates an empty
 * line.
 *
 * ```ts
 * import { newVimState } from './vim.ts';
 *
 * newVimState().mode; // 'insert'
 * newVimState().pending; // '' — nothing typed toward a command yet
 * ```
 */
export function newVimState(): VimState {
  return {
    mode: 'insert',
    pending: '',
    register: '',
    registerIsLine: false,
    undo: [],
    lastChange: '',
    lastFind: null,
  };
}

/**
 * One key against one line.
 *
 * In insert mode the answer is almost always `forward`: readline owns typing, and reimplementing
 * it would be reimplementing a thing that already works. Escape is the exception, and it moves
 * the caret left on the way out, exactly as vim does — the character you just typed is the one
 * you are now sitting on.
 *
 * In normal mode this is the whole grammar. Keys accumulate in {@link VimState.pending} until they
 * say something complete: `d` waits, `2d` waits, `d2` waits, `d2w` deletes two words. A key that
 * cannot begin anything clears the pending keys rather than being held against the next one,
 * which is what stops a typo turning the next keystroke into a surprise.
 *
 * ```ts
 * import { newVimState, pressKey } from './vim.ts';
 *
 * const line = { text: 'const total = 1;', cursor: 0 };
 * const normal = pressKey(newVimState(), line, ''); // Escape — into normal mode
 * normal.state.mode; // 'normal'
 *
 * pressKey(normal.state, line, 'w').line.cursor; // 6 — the start of the next word
 * pressKey(normal.state, line, 'x').line.text; // 'onst total = 1;'
 * ```
 */
export function pressKey(state: VimState, line: Line, key: string): VimStep {
  if (state.mode === 'insert') {
    if (key !== ESCAPE) return { state, line, action: 'forward' };

    return {
      state: { ...state, mode: 'normal', pending: '' },
      line: { ...line, cursor: Math.max(0, line.cursor - 1) },
      action: 'none',
    };
  }

  return normalKey(state, clamped(line), key);
}

const ESCAPE = '';

/**
 * One key in normal mode: either it finishes a command, or it is held for the next one.
 *
 * `pending` is cleared before anything runs, so every path below returns state that is ready for
 * a fresh command rather than one that has to remember to tidy up.
 */
function normalKey(state: VimState, line: Line, key: string): VimStep {
  if (key === ESCAPE) return { state: { ...state, pending: '' }, line, action: 'none' };
  if (key === '\r' || key === '\n') {
    return { state: { ...state, pending: '', mode: 'insert' }, line, action: 'submit' };
  }

  const keys = state.pending + key;
  const ready = { ...state, pending: '' };
  const command = interpret(keys);

  if (command.kind === 'incomplete')
    return { state: { ...state, pending: keys }, line, action: 'none' };
  if (command.kind === 'unknown') return { state: ready, line, action: 'none' };
  if (command.kind === 'motion') {
    const found = motionTo(line, command.motion, command.count, state);

    return {
      state: withFind(ready, command.motion),
      line: found === null ? line : clamped({ ...line, cursor: found.index }),
      action: 'none',
    };
  }
  if (command.kind === 'operator') return operate(ready, line, command, keys);

  return simple(ready, line, command, keys);
}

/** The shapes a complete command can take, plus the two answers that are not commands. */
type Command =
  | { kind: 'incomplete' }
  | { kind: 'unknown' }
  | { kind: 'motion'; motion: Motion; count: number }
  | { kind: 'operator'; operator: 'd' | 'c' | 'y'; target: Target; count: number }
  | { kind: 'simple'; key: string; count: number; argument: string | null };

/** A motion is a key, and for `f`/`t` the character it was given. */
interface Motion {
  key: string;
  char?: string;
}

/** What an operator applies to: a motion, a text object, or the whole line (`dd`, `cc`, `yy`). */
type Target =
  | { kind: 'motion'; motion: Motion; count: number }
  | { kind: 'object'; inner: boolean; object: string }
  | { kind: 'line' };

/** The keys that mean something on their own, with no motion to follow. */
const SIMPLE_KEYS = new Set([
  'i',
  'I',
  'a',
  'A',
  'x',
  'X',
  's',
  'S',
  'D',
  'C',
  'Y',
  'p',
  'P',
  'u',
  '~',
  '.',
  'j',
  'k',
]);

/** The keys that take exactly one character after them. */
const TAKES_A_CHAR = new Set(['f', 'F', 't', 'T', 'r']);

/**
 * What a run of keys means: a finished command, a prefix of one, or nothing at all.
 *
 * Counts first, and `0` is deliberately not one of them when it leads — `0` is a motion to the
 * first column, and `10` is a count. That is vim's own rule, and the reason the digit test starts
 * at 1.
 */
function interpret(keys: string): Command {
  const { count, rest } = splitCount(keys);
  if (rest === '') return { kind: 'incomplete' };

  const head = rest[0] as string;
  if (head === 'd' || head === 'c' || head === 'y') {
    const target = interpretTarget(rest.slice(1), head);
    if (target === 'incomplete') return { kind: 'incomplete' };
    if (target === 'unknown') return { kind: 'unknown' };

    return { kind: 'operator', operator: head, target, count: count ?? 1 };
  }
  if (TAKES_A_CHAR.has(head)) {
    if (rest.length < 2) return { kind: 'incomplete' };
    if (head === 'r') {
      return { kind: 'simple', key: 'r', count: count ?? 1, argument: rest[1] as string };
    }

    return { kind: 'motion', motion: { key: head, char: rest[1] }, count: count ?? 1 };
  }
  if (head === ';' || head === ',') {
    return { kind: 'motion', motion: { key: head }, count: count ?? 1 };
  }
  if (BARE_MOTIONS.has(head)) return { kind: 'motion', motion: { key: head }, count: count ?? 1 };
  if (SIMPLE_KEYS.has(head)) {
    return { kind: 'simple', key: head, count: count ?? 1, argument: null };
  }

  return { kind: 'unknown' };
}

/** What follows an operator: `d` again for the line, `iw`/`a(` for an object, or a motion. */
function interpretTarget(keys: string, operator: string): Target | 'incomplete' | 'unknown' {
  if (keys === '') return 'incomplete';
  const { count, rest } = splitCount(keys);
  if (rest === '') return 'incomplete';
  if (rest === operator) return { kind: 'line' };

  const head = rest[0] as string;
  if (head === 'i' || head === 'a') {
    if (rest.length < 2) return 'incomplete';

    return { kind: 'object', inner: head === 'i', object: rest[1] as string };
  }
  if (TAKES_A_CHAR.has(head) && head !== 'r') {
    if (rest.length < 2) return 'incomplete';

    return { kind: 'motion', motion: { key: head, char: rest[1] }, count: count ?? 1 };
  }
  if (head === ';' || head === ',' || BARE_MOTIONS.has(head)) {
    return { kind: 'motion', motion: { key: head }, count: count ?? 1 };
  }

  return 'unknown';
}

/** A leading count, and what is left. `null` where none was given, so `1` can stay the default. */
function splitCount(keys: string): { count: number | null; rest: string } {
  const match = /^[1-9][0-9]*/.exec(keys);
  if (!match) return { count: null, rest: keys };

  return { count: Number(match[0]), rest: keys.slice(match[0].length) };
}

/**
 * Where a motion lands, and whether an operator over it should include that character.
 *
 * `inclusive` is the difference between `dw` and `de`: both end on a word, and only one of them
 * takes its last character. Getting this wrong is the classic off-by-one in a vi-mode, and it is
 * a property of the MOTION rather than of the operator.
 */
function motionTo(
  line: Line,
  motion: Motion,
  count: number,
  state: VimState,
): { index: number; inclusive: boolean } | null {
  const { text, cursor } = line;
  const repeat = (step: (at: number) => number) => {
    let at = cursor;
    for (let round = 0; round < count; round++) at = step(at);

    return at;
  };

  switch (motion.key) {
    case 'h':
      return { index: Math.max(0, cursor - count), inclusive: false };
    case 'l':
    case ' ':
      return { index: Math.min(text.length, cursor + count), inclusive: false };
    case '0':
      return { index: 0, inclusive: false };
    case '^':
      return { index: firstNonBlank(text), inclusive: false };
    case '$':
      return { index: Math.max(0, text.length - 1), inclusive: true };
    case '|':
      return { index: Math.min(Math.max(0, count - 1), text.length), inclusive: false };
    case 'w':
      return { index: repeat((at) => wordForward(text, at, false)), inclusive: false };
    case 'W':
      return { index: repeat((at) => wordForward(text, at, true)), inclusive: false };
    case 'b':
      return { index: repeat((at) => wordBackward(text, at, false)), inclusive: false };
    case 'B':
      return { index: repeat((at) => wordBackward(text, at, true)), inclusive: false };
    case 'e':
      return { index: repeat((at) => wordEnd(text, at, false)), inclusive: true };
    case 'E':
      return { index: repeat((at) => wordEnd(text, at, true)), inclusive: true };
    case 'f':
    case 'F':
    case 't':
    case 'T':
      return findChar(text, cursor, motion.key, motion.char as string, count);
    case ';':
    case ',':
      return repeatFind(text, cursor, motion.key, count, state);
    default:
      return null;
  }
}

/** `;` and `,`: the last `f`/`t` again, or the same search the other way. */
function repeatFind(
  text: string,
  cursor: number,
  key: string,
  count: number,
  state: VimState,
): { index: number; inclusive: boolean } | null {
  if (state.lastFind === null) return null;
  const same = state.lastFind.key;
  const flipped = { f: 'F', F: 'f', t: 'T', T: 't' }[same] as string;

  return findChar(text, cursor, key === ';' ? same : flipped, state.lastFind.char, count);
}

/**
 * `f`, `F`, `t` and `T`: the count-th occurrence of a character, forward or back.
 *
 * `t` stops one short of what `f` lands on, and the backward pair are exclusive because every
 * backward motion in vim is — `dF(` takes the bracket and stops before the caret.
 */
function findChar(
  text: string,
  cursor: number,
  key: string,
  char: string,
  count: number,
): { index: number; inclusive: boolean } | null {
  const forward = key === 'f' || key === 't';
  let at = cursor;
  for (let round = 0; round < count; round++) {
    const next = forward ? text.indexOf(char, at + 1) : text.lastIndexOf(char, at - 1);
    if (next === -1) return null;
    at = next;
  }
  if (key === 'f') return { index: at, inclusive: true };
  if (key === 't') return { index: Math.max(cursor, at - 1), inclusive: true };
  if (key === 'F') return { index: at, inclusive: false };

  return { index: Math.min(cursor, at + 1), inclusive: false };
}

/** An operator over a target: the text it covers, removed or copied, and where that leaves you. */
function operate(
  state: VimState,
  line: Line,
  command: { operator: 'd' | 'c' | 'y'; target: Target; count: number },
  keys: string,
): VimStep {
  const span = spanOf(line, command.target, command.count, state, command.operator);
  if (span === null) return { state, line, action: 'none' };

  const taken = line.text.slice(span.from, span.to);
  const held = { ...state, register: taken, registerIsLine: command.target.kind === 'line' };
  if (command.operator === 'y') {
    // A yank does not move the caret, except back to where the span started — which is what vim
    // does, and the reason `yyp` puts the line back rather than somewhere else.
    return {
      state: held,
      line: { ...line, cursor: Math.min(span.from, line.cursor) },
      action: 'none',
    };
  }

  const text = line.text.slice(0, span.from) + line.text.slice(span.to);
  const changing = command.operator === 'c';

  return {
    state: {
      ...remembering(held, line),
      mode: changing ? 'insert' : 'normal',
      lastChange: keys,
    },
    line: changing ? { text, cursor: span.from } : clamped({ text, cursor: span.from }),
    action: 'none',
  };
}

/**
 * The half-open span a target covers.
 *
 * `cw` is the famous special case: vim treats it as `ce` when the caret is on a non-blank, because
 * changing a word and then having the space after it disappear is not what anybody means.
 */
function spanOf(
  line: Line,
  target: Target,
  count: number,
  state: VimState,
  operator: string,
): { from: number; to: number } | null {
  if (target.kind === 'line') return { from: 0, to: line.text.length };
  if (target.kind === 'object') return objectSpan(line, target.inner, target.object);

  const motion =
    operator === 'c' && (target.motion.key === 'w' || target.motion.key === 'W')
      ? { key: target.motion.key === 'w' ? 'e' : 'E' }
      : target.motion;
  const onBlank = isBlank(line.text[line.cursor] ?? ' ');
  const effective = operator === 'c' && onBlank ? target.motion : motion;

  const found = motionTo(line, effective, count * target.count, state);
  if (found === null) return null;

  const end = found.inclusive ? found.index + 1 : found.index;

  return end >= line.cursor
    ? { from: line.cursor, to: Math.min(end, line.text.length) }
    : { from: Math.max(0, end), to: line.cursor };
}

/** `iw`/`aw`, and the bracket and quote pairs — the objects a code prompt actually wants. */
function objectSpan(
  line: Line,
  inner: boolean,
  object: string,
): { from: number; to: number } | null {
  const { text, cursor } = line;
  if (object === 'w' || object === 'W') {
    const big = object === 'W';
    if (text === '') return null;
    const from = runStart(text, cursor, big);
    const to = runEnd(text, cursor, big) + 1;
    if (!inner) {
      let after = to;
      while (after < text.length && isBlank(text[after] as string)) after++;

      return { from, to: after };
    }

    return { from, to };
  }
  const pair = PAIRS.get(object);
  if (pair) return bracketSpan(text, cursor, pair[0], pair[1], inner);
  if (QUOTES.has(object)) return quoteSpan(text, cursor, object, inner);

  return null;
}

/** The enclosing bracket pair, counting nesting so `di(` inside `f(g(x))` takes the inner one. */
function bracketSpan(
  text: string,
  cursor: number,
  open: string,
  close: string,
  inner: boolean,
): { from: number; to: number } | null {
  let depth = 0;
  let start = -1;
  for (let at = cursor; at >= 0; at--) {
    const char = text[at];
    if (char === close && at !== cursor) depth++;
    else if (char === open) {
      if (depth === 0) {
        start = at;
        break;
      }
      depth--;
    }
  }
  if (start === -1) return null;

  depth = 0;
  for (let at = start + 1; at < text.length; at++) {
    const char = text[at];
    if (char === open) depth++;
    else if (char === close) {
      if (depth === 0) {
        return inner ? { from: start + 1, to: at } : { from: start, to: at + 1 };
      }
      depth--;
    }
  }

  return null;
}

/**
 * The quoted run the caret is in, or the next one after it.
 *
 * Quotes have no nesting to count, so they are paired off in order from the start of the line —
 * which is what vim does, and why `ci"` on the space between two strings reaches the second one.
 */
function quoteSpan(
  text: string,
  cursor: number,
  quote: string,
  inner: boolean,
): { from: number; to: number } | null {
  const at: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === quote && text[index - 1] !== '\\') at.push(index);
  }
  for (let pair = 0; pair + 1 < at.length; pair += 2) {
    const open = at[pair] as number;
    const close = at[pair + 1] as number;
    if (cursor <= close) {
      return inner ? { from: open + 1, to: close } : { from: open, to: close + 1 };
    }
  }

  return null;
}

/** The keys that mean something on their own. */
function simple(
  state: VimState,
  line: Line,
  command: { key: string; count: number; argument: string | null },
  keys: string,
): VimStep {
  const { text, cursor } = line;
  const changed = (next: Line, mode: Mode = 'normal') => ({
    state: { ...remembering(state, line), mode, lastChange: keys },
    line: mode === 'insert' ? next : clamped(next),
    action: 'none' as VimAction,
  });

  switch (command.key) {
    case 'i':
      return { state: { ...state, mode: 'insert' }, line, action: 'none' };
    case 'I':
      return {
        state: { ...state, mode: 'insert' },
        line: { text, cursor: firstNonBlank(text) },
        action: 'none',
      };
    case 'a':
      return {
        state: { ...state, mode: 'insert' },
        line: { text, cursor: Math.min(text.length, cursor + 1) },
        action: 'none',
      };
    case 'A':
      return {
        state: { ...state, mode: 'insert' },
        line: { text, cursor: text.length },
        action: 'none',
      };
    case 'x': {
      const to = Math.min(text.length, cursor + command.count);

      return {
        ...changed({ text: text.slice(0, cursor) + text.slice(to), cursor }),
        state: {
          ...remembering(state, line),
          register: text.slice(cursor, to),
          registerIsLine: false,
          lastChange: keys,
        },
      };
    }
    case 'X': {
      const from = Math.max(0, cursor - command.count);

      return {
        ...changed({ text: text.slice(0, from) + text.slice(cursor), cursor: from }),
        state: {
          ...remembering(state, line),
          register: text.slice(from, cursor),
          registerIsLine: false,
          lastChange: keys,
        },
      };
    }
    case 's': {
      const to = Math.min(text.length, cursor + command.count);

      return changed({ text: text.slice(0, cursor) + text.slice(to), cursor }, 'insert');
    }
    case 'S':
      return changed({ text: '', cursor: 0 }, 'insert');
    case 'D':
      return changed({ text: text.slice(0, cursor), cursor });
    case 'C':
      return changed({ text: text.slice(0, cursor), cursor }, 'insert');
    case 'Y':
      return {
        state: { ...state, register: text, registerIsLine: true },
        line,
        action: 'none',
      };
    case 'p':
    case 'P': {
      if (state.register === '') return { state, line, action: 'none' };
      const pasted = state.register.repeat(command.count);
      // A linewise register replaces the line, because the new line vim would have put it on
      // does not exist here. `dd` then `p` is how you take a line back.
      if (state.registerIsLine) return changed({ text: pasted, cursor: firstNonBlank(pasted) });

      const at = command.key === 'p' ? Math.min(text.length, cursor + 1) : cursor;

      return changed({
        text: text.slice(0, at) + pasted + text.slice(at),
        cursor: at + pasted.length - 1,
      });
    }
    case 'r': {
      const argument = command.argument as string;
      if (cursor + command.count > text.length) return { state, line, action: 'none' };
      const run = argument.repeat(command.count);

      return changed({
        text: text.slice(0, cursor) + run + text.slice(cursor + command.count),
        cursor: cursor + command.count - 1,
      });
    }
    case '~': {
      const to = Math.min(text.length, cursor + command.count);
      const flipped = [...text.slice(cursor, to)]
        .map((char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()))
        .join('');

      return changed({ text: text.slice(0, cursor) + flipped + text.slice(to), cursor: to });
    }
    case 'u': {
      const previous = state.undo.at(-1);
      if (previous === undefined) return { state, line, action: 'none' };

      return {
        state: { ...state, undo: state.undo.slice(0, -1) },
        line: clamped(previous),
        action: 'none',
      };
    }
    case '.':
      return repeatChange(state, line);
    case 'k':
      return { state, line, action: 'historyPrev' };
    case 'j':
      return { state, line, action: 'historyNext' };
    default:
      return { state, line, action: 'none' };
  }
}

/**
 * `.` — the last change again, by replaying the keys that made it.
 *
 * Replayed rather than remembered as an effect, because an effect recorded at one caret position
 * is the wrong effect at another: `.` after moving is supposed to do the same THING somewhere
 * else. A `.` is never itself recorded, so this cannot recurse.
 */
function repeatChange(state: VimState, line: Line): VimStep {
  if (state.lastChange === '') return { state, line, action: 'none' };

  let step: VimStep = { state: { ...state, pending: '' }, line, action: 'none' };
  for (const key of state.lastChange) step = pressKey(step.state, step.line, key);

  // The replay may have left insert mode open (`cw`), which a bare `.` must not do — there is
  // nobody about to type the rest of it.
  return { ...step, state: { ...step.state, mode: 'normal', lastChange: state.lastChange } };
}

/** The line, kept for `u`, oldest dropped once there are {@link UNDO_KEPT} of them. */
function remembering(state: VimState, line: Line): VimState {
  const undo = [...state.undo, { ...line }];

  return { ...state, undo: undo.length > UNDO_KEPT ? undo.slice(1) : undo };
}

/** `f`/`t` are what `;` repeats, so every one of them is recorded; nothing else touches it. */
function withFind(state: VimState, motion: Motion): VimState {
  if (motion.char === undefined || !'fFtT'.includes(motion.key)) return state;

  return { ...state, lastFind: { key: motion.key, char: motion.char } };
}

/** Normal mode sits ON a character, so the caret never rests past the last one. */
function clamped(line: Line): Line {
  return { ...line, cursor: Math.max(0, Math.min(line.cursor, Math.max(0, line.text.length - 1))) };
}

/** The column `^` means. The line's end where there is nothing but blanks. */
function firstNonBlank(text: string): number {
  const at = text.search(/\S/);

  return at === -1 ? Math.max(0, text.length - 1) : at;
}

function isBlank(char: string): boolean {
  return char === ' ' || char === '\t';
}

/**
 * Which of vim's three character classes this is.
 *
 * Word, punctuation and blank — and the reason `w` on `const.total` stops at the dot while `W`
 * carries on past it. A vi-mode that borrowed readline's alphanumeric-only idea of a word gets
 * every motion over an expression subtly wrong.
 */
function classOf(char: string, big: boolean): 'blank' | 'word' | 'punct' {
  if (isBlank(char)) return 'blank';
  if (big) return 'word';

  return /[A-Za-z0-9_]/.test(char) ? 'word' : 'punct';
}

/** `w`/`W`: the next start of a word, or the end of the line where there is no next. */
function wordForward(text: string, cursor: number, big: boolean): number {
  let at = cursor;
  const start = classOf(text[at] ?? ' ', big);
  if (start !== 'blank') {
    while (at < text.length && classOf(text[at] as string, big) === start) at++;
  }
  while (at < text.length && isBlank(text[at] as string)) at++;

  return at;
}

/** `b`/`B`: the previous start of a word. */
function wordBackward(text: string, cursor: number, big: boolean): number {
  let at = cursor - 1;
  while (at >= 0 && isBlank(text[at] as string)) at--;
  if (at < 0) return 0;
  const run = classOf(text[at] as string, big);
  while (at > 0 && classOf(text[at - 1] as string, big) === run) at--;

  return Math.max(0, at);
}

/** `e`/`E`: the last character of this word, or of the next one where already at an end. */
function wordEnd(text: string, cursor: number, big: boolean): number {
  let at = cursor + 1;
  while (at < text.length && isBlank(text[at] as string)) at++;
  if (at >= text.length) return Math.max(0, text.length - 1);
  const run = classOf(text[at] as string, big);
  while (at + 1 < text.length && classOf(text[at + 1] as string, big) === run) at++;

  return at;
}

/** The first character of the run the caret is in — what `iw` starts at. */
function runStart(text: string, cursor: number, big: boolean): number {
  const run = classOf(text[cursor] ?? ' ', big);
  let at = cursor;
  while (at > 0 && classOf(text[at - 1] as string, big) === run) at--;

  return at;
}

/** And the last character of it. */
function runEnd(text: string, cursor: number, big: boolean): number {
  const run = classOf(text[cursor] ?? ' ', big);
  let at = cursor;
  while (at + 1 < text.length && classOf(text[at + 1] as string, big) === run) at++;

  return at;
}
