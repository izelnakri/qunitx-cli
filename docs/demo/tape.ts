// The tape language: `demo.tape` in, scenes out. Pure — it reads a string and returns data, so
// the studio in make-gif.ts is the only part that needs ttyd, a browser or ffmpeg.
//
// The commands are VHS's wherever VHS has one, because a tape nobody has to learn is the whole
// point. `Caption`, `Pane` and `Fix` are ours; VHS records one terminal and has no notion of a
// second pane or of editing a file mid-take.

/** One thing a scene does. `Wait` blocks on the terminal; the rest are immediate. */
export type Step =
  | { do: 'type'; text: string }
  | { do: 'press'; key: 'Enter' | 'Control+C' | 'Control+D' }
  | { do: 'sleep'; ms: number }
  | { do: 'wait'; pattern: RegExp }
  | { do: 'pane'; shot: string }
  | { do: 'fix' };

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
 * import { parseTape } from './tape.ts';
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
    scene.steps.push(step(at, text, command, rest));
  }

  if (scenes.length === 0) throw new TapeError(1, source.split('\n')[0] ?? '', 'no scenes');

  return scenes;
}

/** Every caption, in order — what the strip along the top says. */
export function captionsOf(scenes: readonly Scene[]): [title: string, detail: string][] {
  return scenes.map(({ title, detail }) => [title, detail]);
}

/** Every pane a tape names, once each, in the order they are first used. */
export function panesOf(scenes: readonly Scene[]): string[] {
  const named = scenes.flatMap(({ steps }) =>
    steps.flatMap((one) => (one.do === 'pane' ? [one.shot] : [])),
  );

  return [...new Set(named)];
}

function step(at: number, text: string, command: string, rest: string): Step {
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
    case 'Pane': {
      if (!/^[\w-]+$/.test(rest)) throw new TapeError(at, text, 'Pane takes one shot name');

      return { do: 'pane', shot: rest };
    }
    case 'Fix':
      return { do: 'fix' };
    default:
      throw new TapeError(at, text, `no such command: ${command}`);
  }
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
