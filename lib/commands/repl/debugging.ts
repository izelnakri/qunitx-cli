import process from 'node:process';
import { paint } from '../../repl/columns.ts';
import { excerpt, limits } from '../../repl/excerpt.ts';
import type { REPLServer } from 'node:repl';
import type { ReplCommand } from './command.ts';
import type * as Repl from '../../repl/session.ts';
import type { ReplSession } from '../../repl/session.ts';
import type { Theme } from '../../repl/theme.ts';
import { blue, red } from '../../utils/color.ts';

/**
 * The source around wherever the page is stopped, drawn under whatever announced the stop.
 *
 * ```ts
 * import { showFrame } from './debugging.ts';
 *
 * import type { REPLServer } from 'node:repl';
 * import type { ReplSession } from '../../repl/session.ts';
 * import type { Theme } from '../../repl/theme.ts';
 *
 * // Defined, not invoked: it reads a stopped page.
 * function example(server: REPLServer, session: ReplSession, palette: Theme) {
 *   return showFrame(server, session, palette);
 * }
 * ```
 */
export async function showFrame(
  server: REPLServer,
  session: ReplSession,
  palette: Theme,
): Promise<void> {
  const frame = await session.frameSource();
  const shown = frame ? excerpt(frame.text, frame.line, palette, limits()) : '';
  if (shown !== '') server.output.write(`${shown}\n`);
}

/**
 * Every command a stopped page answers: moving through it, moving about its stack, and the
 * breakpoints that stop it in the first place.
 *
 * Defined here rather than beside the rest because everything they need is here — the step names,
 * the frame directions, the counts they take and how a stop is announced. A command and the things
 * only it uses belong in one file.
 *
 * ```ts
 * import { showFrame } from './debugging.ts';
 *
 * import type { REPLServer } from 'node:repl';
 * import type { ReplSession } from '../../repl/session.ts';
 * import type { Theme } from '../../repl/theme.ts';
 *
 * // Defined, not invoked: it needs a live prompt and a live page.
 * function example(server: REPLServer, session: ReplSession, palette: Theme) {
 *   return showFrame(server, session, palette);
 * }
 * ```
 */
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
/**
 * A count typed after a command, `fallback` where none was, or `null` where it was not a count.
 *
 * Every one of these took an argument and ignored it before this existed, which is the worst way
 * to be wrong: `.up 3` moved one frame and said nothing about the other two.
 *
 * ```ts
 * import { count } from './debugging.ts';
 *
 * count('3'); // 3
 * count(''); // 1 — nothing typed is once
 * count('lots'); // null — not a count, and not a silent 1
 * ```
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
async function repeat(times: number, once: () => Promise<string | null>): Promise<string | null> {
  let where: string | null = null;
  for (let at = 0; at < times; at++) {
    where = await once();
    if (where === null) return null;
  }

  return where;
}

/**
 * The stack as gdb prints one: newest first, numbered from where it stopped.
 *
 * ```ts
 * import { stack } from './debugging.ts';
 *
 * const plain = { style: () => '' };
 * stack([{ index: 0, where: 'outer (a.ts:1:1)', selected: true }], plain);
 * // '> #0  outer (a.ts:1:1)' — the one being read is marked
 * ```
 */
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
 * What `.step`, `.next` and `.finish` all do, differing only in which way out of the line they
 * take — the three gdb named, and the only way into another frame from a breakpoint.
 *
 * A `debugger` statement inside something you CALL while stopped does nothing, because V8 disables
 * breakpoints for the duration of a debugger evaluation; stepping is what gets you in there.
 *
 * ```ts
 * import { stepping } from './debugging.ts';
 *
 * typeof stepping('step', 'into'); // 'function' — a command's `main`, waiting for a context
 * ```
 */
export function stepping(name: string, kind: Repl.StepKind): ReplCommand['main'] {
  return async (repl, argument) => {
    const times = count(argument);
    if (times === null) {
      repl.write(`Usage: .${name} [count]\n`);

      return repl.prompt();
    }
    if (!repl.session.pausedAt) {
      repl.write('Not paused\n');

      return repl.prompt();
    }
    // Only where it ends up is printed. A count means "do this n times", and n locations on the
    // way is the noise you asked to skip by giving one.
    const where = await repeat(times, () => repl.session.step(kind));
    if (where === null) repl.write(blue('the page carried on\n'));
    else {
      repl.write(blue(`${where}\n`));
      await showFrame(repl.server, repl.session, repl.palette);
    }
    repl.prompt();
  };
}

/**
 * What `.up`, `.down`, `.frame`, `.here` and `.back` all do: pick a frame to read.
 *
 * `direction` is gdb's, about the stack growing downwards rather than about the list on screen —
 * `1` toward whoever called this, `-1` back toward where it stopped, `0` for an absolute number.
 * `counted` is false for `.here`, which asks one question and takes nothing to answer it.
 *
 * ```ts
 * import { moving } from './debugging.ts';
 *
 * typeof moving('up', 1, true); // 'function' — a command's `main`, waiting for a context
 * ```
 */
export function moving(name: string, direction: number, counted: boolean): ReplCommand['main'] {
  return async (repl, argument) => {
    if (!repl.session.pausedAt) {
      repl.write('Not paused\n');

      return repl.prompt();
    }
    const here = repl.session.backtrace().find((frame) => frame.selected)?.index ?? 0;
    // `.here` asks one question and takes nothing to answer it. Reading an argument and moving
    // somewhere would be the command doing what its name does not say.
    if (!counted && argument.trim() !== '') {
      repl.write(`Usage: .${name}\n`);

      return repl.prompt();
    }
    // `.frame` with nothing after it says where you are without moving, which is what gdb's does —
    // and what stops it meaning "go to frame 0", because `Number('')` is zero.
    const given = count(argument, direction === 0 ? here : 1);
    if (given === null) {
      repl.write(`Usage: .${name} ${direction === 0 ? '[number]' : '[count]'}\n`);

      return repl.prompt();
    }
    // A direction times a count, or the number itself. `up -1` is `down 1`, as in gdb.
    const where = repl.session.selectFrame(direction === 0 ? given : here + direction * given);
    if (where === null) {
      repl.write(red('No such frame\n'));

      return repl.prompt();
    }
    repl.write(blue(`${where}\n`));
    await showFrame(repl.server, repl.session, repl.palette);
    repl.prompt();
  };
}
