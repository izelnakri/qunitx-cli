import process from 'node:process';
import { paint } from '../../repl/columns.ts';
import { excerpt, limits } from '../../repl/excerpt.ts';
import type { REPLServer } from 'node:repl';
import type * as Repl from '../../repl/session.ts';
import type { ReplSession } from '../../repl/session.ts';
import type { Theme } from '../../repl/theme.ts';

/**
 * Moving about the stack. `0` means the argument is a frame number rather than a distance.
 *
 * `.back` is `.up` because the caller ran BEFORE the frame it called — back in execution order is
 * outward on the stack. gdb spells `back` as an abbreviation of `backtrace` instead, which is
 * gdb's prefix-matching rather than gdb's judgement, and reads wrong at a prompt where a person
 * typing "back" means "take me back".
 *
 * There is deliberately no `.prev`. It would be another word for the same move, and it invites a
 * `.next` to answer it — which is already the step-over command, and would leave the pair meaning
 * two unrelated things.
 */
export const FRAMES: ReadonlyArray<{
  name: string;
  direction: number;
  count: boolean;
  help: string;
}> = [
  {
    name: 'frame',
    direction: 0,
    count: true,
    help: 'Say which frame is being read, or go to one — `.frame 1`',
  },
  { name: 'here', direction: 0, count: false, help: 'Say which frame is being read' },
  {
    name: 'up',
    direction: 1,
    count: true,
    help: 'Go toward the frame that called this one — `.up 2` for two',
  },
  {
    name: 'back',
    direction: 1,
    count: true,
    help: 'Back toward the caller, which is back in execution order',
  },
  {
    name: 'down',
    direction: -1,
    count: true,
    help: 'Go back toward the frame this one called — `.down 2` for two',
  },
];

/**
 * A count typed after a command, `fallback` where none was, or `null` where it was not a count.
 *
 * Every one of these took an argument and ignored it before this existed, which is the worst way
 * to be wrong: `.up 3` moved one frame and said nothing about the other two.
 */
export function count(argument: string, fallback: number = 1): number | null {
  const given = argument.trim();
  if (given === '') return fallback;
  const asked = Number(given);

  return Number.isInteger(asked) ? asked : null;
}

/**
 * Does something `times` over, stopping early if it stops answering, and reports where it ended.
 *
 * A count means "do this n times", so only the last answer is worth printing — n locations on the
 * way is exactly the noise the count was asking to skip.
 */
export async function repeat(
  times: number,
  once: () => Promise<string | null>,
): Promise<string | null> {
  let where: string | null = null;
  for (let at = 0; at < times; at++) {
    where = await once();
    if (where === null) return null;
  }

  return where;
}

/** The stack as gdb prints one: newest first, numbered from where it stopped. */
export function stack(frames: readonly Repl.Frame[], palette: Theme): string {
  const dim = palette.style('LineNr');
  const mark = palette.style('@keyword');

  return frames
    .map(({ index, where, selected }) => {
      const number = `#${index}`;
      const edge = selected
        ? `${paint('>', mark)} ${paint(number, mark)}`
        : `  ${paint(number, dim)}`;

      return `${edge}  ${where}`;
    })
    .join('\n');
}

/**
 * What to say when the page has gone.
 *
 * There is nothing to recover and nothing to offer: a REPL's whole value is the page it is holding
 * — the bindings, the DOM, the module state — and all of it went at once. Reopening one would not
 * bring any of it back; it would be the session you get by running the command again, which the
 * shell already remembers. So the message says what was lost and what to type, and the process
 * ends rather than sitting at a prompt that cannot answer anything.
 *
 * ```ts
 * import { lost } from './debugging.ts';
 *
 * lost(['node', 'cli.ts', 'repl', 'a.ts']).includes('qunitx repl a.ts'); // true — what to type
 * ```
 */
export function lost(argv: readonly string[] = process.argv): string {
  const again = argv.slice(2).join(' ');

  return [
    'the page is gone — the browser closed, crashed, or was killed.',
    'Everything it was holding went with it, so there is nothing here to carry on with.',
    again === '' ? 'Run qunitx repl again to start over.' : `Start again with: qunitx ${again}`,
  ].join('\n');
}

/** The three ways out of a line, under the names gdb gave them. */
export const STEPS: ReadonlyArray<[string, Repl.StepKind, string]> = [
  ['step', 'into', 'Run one step, entering the next call'],
  ['next', 'over', 'Run one step, over the next call rather than into it'],
  ['finish', 'out', 'Run until the current frame returns'],
];

/** The source around wherever the page is stopped, drawn under whatever announced the stop. */
export async function showFrame(
  server: REPLServer,
  session: ReplSession,
  palette: Theme,
): Promise<void> {
  const frame = await session.frameSource();
  const shown = frame ? excerpt(frame.text, frame.line, palette, limits()) : '';
  if (shown !== '') server.output.write(`${shown}\n`);
}
