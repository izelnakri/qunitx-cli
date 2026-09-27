// The language, and the clock: a `.tape` in, scenes out. Pure — it reads a string and returns
// data, so `demo.ts` stays the only part that needs ttyd, a browser or ffmpeg.
//
// The commands are VHS's wherever VHS has one, because a tape nobody has to learn is the whole
// point. `Caption`, `Pane` and `Do` are ours; VHS records one terminal and has no notion of a
// second pane or of anything happening off camera.

/** Keystroke to keystroke, so typing reads at a human speed rather than appearing at once. */
export const TYPING_MS = 35;
/** How long a `Wait` shows for, however long it actually took. */
export const WAIT_HOLD_MS = 1_200;

/** One thing a scene does. `Wait` blocks on the terminal; the rest are immediate. */
export type Step =
  | { do: 'type'; text: string }
  | { do: 'press'; key: 'Enter' | 'Control+C' | 'Control+D' }
  | { do: 'sleep'; ms: number }
  | { do: 'wait'; pattern: RegExp }
  | { do: 'pane'; name: string }
  | { do: 'action'; name: string };

/** A caption, and everything that happens while it is on screen. */
export interface Scene {
  title: string;
  detail: string;
  steps: Step[];
}

/** Where a bad line is, so the message can point at it the way a compiler would. */
export class TapeError extends Error {
  constructor(line: number, text: string, why: string) {
    super(`demo.tape:${line}: ${why}\n  ${text.trim()}`);
    this.name = 'TapeError';
  }
}

/**
 * Reads a tape.
 *
 * Every line is one command, blank lines and `#` comments are skipped, and anything before the
 * first `Caption` is an error rather than a scene nobody captioned.
 *
 * ```ts
 * import { parseTape } from 'demogod';
 *
 * const [scene] = parseTape('Caption "Run it" "in a real browser"\nType "qunitx test/"\nEnter');
 * scene.title; // 'Run it'
 * scene.steps.length; // 2
 * ```
 */
export function parseTape(source: string): Scene[] {
  const scenes: Scene[] = [];

  for (const [index, text] of source.split('\n').entries()) {
    const line = text.trim();
    if (line === '' || line.startsWith('#')) continue;

    const at = index + 1;
    const [command = '', rest = ''] = splitOnce(line);
    if (command === 'Caption') {
      const [title, detail] = quoted(rest);
      if (title === undefined || detail === undefined) {
        throw new TapeError(at, text, 'Caption takes a quoted title and a quoted detail');
      }
      scenes.push({ title, detail, steps: [] });
      continue;
    }

    const scene = scenes.at(-1);
    if (!scene) throw new TapeError(at, text, `${command} before any Caption`);
    scene.steps.push(parseStep(at, text, command, rest));
  }

  if (scenes.length === 0) throw new TapeError(1, source.split('\n')[0] ?? '', 'no scenes');

  return scenes;
}

/**
 * How long a step SHOULD take, which is what the tape says rather than what the machine managed.
 *
 * Everything the recorder does takes longer on a busy machine, and two of them take much longer: a
 * `Wait` ends when a command finishes, and `Type` pays a round trip per keystroke on top of its
 * delay. Recorded at 2x load this demo ran 84s instead of 64s; recorded while the machine was
 * still settling, 78s. Nothing was wrong with any of them — they are recordings of real commands,
 * and the commands were slow.
 *
 * So the pictures come from the recording and the clock comes from here. A `Wait` always shows for
 * {@link WAIT_HOLD_MS}, whether it waited for a tenth of that or ten times it, because what is on
 * screen while a command runs is a command running.
 */
export function nominalMs(step: Step, tookMs: number): number {
  if (step.do === 'sleep') return step.ms;
  if (step.do === 'type') return step.text.length * TYPING_MS;
  if (step.do === 'wait') return WAIT_HOLD_MS;

  // A keypress, a pane switch, something off camera: nothing to watch, nothing to stretch.
  return Math.min(tookMs, 100);
}

/** Anything with a moment attached: a recorded frame, a pane switch. */
export interface Timed {
  atMs: number;
}

/**
 * Puts a recording on the tape's clock.
 *
 * `marks` pairs each step boundary's real timestamp with the one it should be shown at, so this
 * only has to place what happened in between — proportionally, since a step that took four seconds
 * to type and should take two has frames all the way through it. Whatever then lands on the same
 * shown millisecond collapses to the first, which is the one the screen actually held.
 *
 * ```ts
 * import { onTapeClock } from 'demogod';
 *
 * const marks = [{ atMs: 0, showMs: 0 }, { atMs: 9_000, showMs: 1_200 }];
 * onTapeClock(marks, [{ atMs: 0 }, { atMs: 4_500 }], []).durationMs; // 1200
 * ```
 */
export function onTapeClock<F extends Timed, P extends Timed>(
  marks: readonly { atMs: number; showMs: number }[],
  frames: readonly F[],
  panes: readonly P[],
): { frames: F[]; panes: P[]; durationMs: number } {
  const shown = (atMs: number): number => {
    const next = marks.findIndex((mark) => mark.atMs > atMs);
    if (next <= 0) return next === 0 ? 0 : marks.at(-1)!.showMs;

    const from = marks[next - 1]!;
    const to = marks[next]!;
    const span = to.atMs - from.atMs;
    const part = span === 0 ? 1 : (atMs - from.atMs) / span;

    return Math.round(from.showMs + (to.showMs - from.showMs) * part);
  };
  const seen = new Set<number>();

  return {
    frames: frames
      .map((frame) => ({ ...frame, atMs: shown(frame.atMs) }))
      .filter(({ atMs }) => !seen.has(atMs) && seen.add(atMs) !== undefined),
    panes: panes.map((pane) => ({ ...pane, atMs: shown(pane.atMs) })),
    durationMs: marks.at(-1)!.showMs,
  };
}

/** Every caption, in order — what the strip along the top says. */
export function captionsOf(scenes: readonly Scene[]): [title: string, detail: string][] {
  return scenes.map(({ title, detail }) => [title, detail]);
}

/** Every pane a tape names, once each, in the order they are first used. */
export function panesOf(scenes: readonly Scene[]): string[] {
  const named = scenes.flatMap(({ steps }) =>
    steps.flatMap((one) => (one.do === 'pane' ? [one.name] : [])),
  );

  return [...new Set(named)];
}

function parseStep(at: number, text: string, command: string, rest: string): Step {
  switch (command) {
    case 'Type': {
      const [typed] = quoted(rest);
      if (typed === undefined) throw new TapeError(at, text, 'Type takes a quoted string');

      return { do: 'type', text: typed };
    }
    case 'Enter':
      return { do: 'press', key: 'Enter' };
    case 'Ctrl+C':
      return { do: 'press', key: 'Control+C' };
    case 'Ctrl+D':
      return { do: 'press', key: 'Control+D' };
    case 'Sleep':
      return { do: 'sleep', ms: duration(at, text, rest) };
    case 'Wait':
      return { do: 'wait', pattern: regexp(at, text, rest) };
    case 'Pane':
      return { do: 'pane', name: bareWord(at, text, 'Pane', rest) };
    case 'Do':
      return { do: 'action', name: bareWord(at, text, 'Do', rest) };
    default:
      throw new TapeError(at, text, `no such command: ${command}`);
  }
}

/** A single bare word: the name of a pane to show, or of an action to run. */
function bareWord(at: number, text: string, command: string, value: string): string {
  if (!/^[\w-]+$/.test(value)) throw new TapeError(at, text, `${command} takes one name`);

  return value;
}

/** `500ms`, `2s`, `3.5s` — VHS's own spelling, and the only two units it has. */
function duration(at: number, text: string, value: string): number {
  const found = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(value);
  if (!found) throw new TapeError(at, text, `not a duration: ${value || '(nothing)'} — try 500ms`);

  return Number(found[1]) * (found[2] === 's' ? 1000 : 1);
}

/** `/pattern/` with optional flags, the way it would be written in JavaScript. */
function regexp(at: number, text: string, value: string): RegExp {
  const found = /^\/(.+)\/([a-z]*)$/.exec(value);
  if (!found) throw new TapeError(at, text, `not a pattern: ${value || '(nothing)'} — try /ok 1/`);
  try {
    return new RegExp(found[1]!, found[2]);
  } catch (error) {
    throw new TapeError(at, text, (error as Error).message);
  }
}

/** The double-quoted strings on a line, unescaped. Nothing outside them is read. */
function quoted(value: string): string[] {
  return [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(([, body = '']) =>
    body.replace(/\\(.)/g, '$1'),
  );
}

function splitOnce(line: string): [string, string] {
  const space = line.indexOf(' ');

  return space === -1 ? [line, ''] : [line.slice(0, space), line.slice(space + 1).trim()];
}
