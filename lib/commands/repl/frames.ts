import { excerpt, limits } from '../../repl/excerpt.ts';
import { styled } from '../../repl/columns.ts';
import { asCount } from './command.ts';
import { blue, red } from '../../utils/color.ts';
import type * as Repl from '../../repl/session.ts';
import type { ReplCommand, ReplContext } from './command.ts';
import type { Theme } from '../../repl/theme.ts';

/**
 * The source around wherever the page is stopped, drawn under whatever announced the stop.
 *
 * ```ts
 * import { showFrame } from './frames.ts';
 *
 * import type { ReplContext } from './command.ts';
 *
 * // Defined, not invoked: it reads a stopped page.
 * function example(repl: ReplContext) {
 *   return showFrame(repl);
 * }
 * ```
 */
export async function showFrame(repl: ReplContext): Promise<void> {
  const frame = await repl.session.frameSource();
  const shown = frame ? excerpt(frame.text, frame.line, repl.palette, limits()) : '';
  if (shown !== '') repl.log(shown);
}

/**
 * The stack as gdb prints one: newest first, numbered from where it stopped, with a mark on the
 * frame being read.
 *
 * ```ts
 * import { frameList } from './frames.ts';
 *
 * const plain = { style: () => '' };
 * frameList([{ index: 0, where: 'outer (a.ts:1:1)', selected: true }], plain);
 * // '> #0  outer (a.ts:1:1)'
 * ```
 */
export function frameList(frames: readonly Repl.Frame[], palette: Theme): string {
  const dim = palette.style('LineNr');
  const mark = palette.style('@keyword');

  return frames
    .map(({ index, where, selected }) => {
      const number = `#${index}`;
      const edge = selected
        ? `${styled('>', mark)} ${styled(number, mark)}`
        : `  ${styled(number, dim)}`;

      return `${edge}  ${where}`;
    })
    .join('\n');
}

/**
 * `.step` — one step, into whatever the line calls.
 *
 * The three step commands differ only in which way out of the line they take, so each is this
 * factory under gdb's name for it. Named rather than `stepping(name, 'into')`, because a call site
 * reading `steppingInto('step')` needs no trip to the definition to know what it does.
 *
 * Stepping is also the only way INTO another frame from a breakpoint: a `debugger` statement
 * inside something you CALL while stopped does nothing, because V8 disables breakpoints for the
 * duration of a debugger evaluation.
 *
 * ```ts
 * import { steppingInto } from './frames.ts';
 *
 * typeof steppingInto('step'); // 'function' — a command's `main`, waiting for a context
 * ```
 */
export function steppingInto(name: string): ReplCommand['main'] {
  return stepping(name, 'into');
}

/**
 * `.next` — one step, running the next call rather than entering it.
 *
 * ```ts
 * import { steppingOver } from './frames.ts';
 *
 * typeof steppingOver('next'); // 'function' — a command's `main`, waiting for a context
 * ```
 */
export function steppingOver(name: string): ReplCommand['main'] {
  return stepping(name, 'over');
}

/**
 * `.finish` — run until this frame returns, and stop in whoever called it.
 *
 * ```ts
 * import { steppingOut } from './frames.ts';
 *
 * typeof steppingOut('finish'); // 'function' — a command's `main`, waiting for a context
 * ```
 */
export function steppingOut(name: string): ReplCommand['main'] {
  return stepping(name, 'out');
}

/**
 * `.up` and `.back` — toward whoever called this frame.
 *
 * Up the stack, which grows downwards: outward is where the caller is. `.back` is the same move
 * because the caller ran BEFORE the frame it called, so back in execution order is outward —
 * gdb spells `back` as an abbreviation of `backtrace`, which is its prefix-matching rather than
 * its judgement, and reads wrong at a prompt where somebody typing "back" means "take me back".
 *
 * There is deliberately no `.prev`: another word for the same move, and it invites a `.next` to
 * answer it, which is already the step-over command.
 *
 * ```ts
 * import { towardCaller } from './frames.ts';
 *
 * typeof towardCaller('up'); // 'function' — a command's `main`, waiting for a context
 * ```
 */
export function towardCaller(name: string): ReplCommand['main'] {
  return selecting(name, { step: 1, counted: true });
}

/**
 * `.down` — back toward the frame this one called, which is where the page actually stopped.
 *
 * ```ts
 * import { towardCallee } from './frames.ts';
 *
 * typeof towardCallee('down'); // 'function' — a command's `main`, waiting for a context
 * ```
 */
export function towardCallee(name: string): ReplCommand['main'] {
  return selecting(name, { step: -1, counted: true });
}

/**
 * `.frame` — a frame by its number, or, with nothing after it, which one is being read.
 *
 * Bare it moves nowhere, which is what gdb's does — and what stops it meaning "go to frame 0",
 * since `Number('')` is zero.
 *
 * ```ts
 * import { toFrameNumber } from './frames.ts';
 *
 * typeof toFrameNumber('frame'); // 'function' — a command's `main`, waiting for a context
 * ```
 */
export function toFrameNumber(name: string): ReplCommand['main'] {
  return selecting(name, { step: 0, counted: true });
}

/**
 * `.here` — which frame is being read, and nothing else.
 *
 * It asks one question and takes nothing to answer it. Reading an argument and moving somewhere
 * would be the command doing what its name does not say.
 *
 * ```ts
 * import { whereWeAre } from './frames.ts';
 *
 * typeof whereWeAre('here'); // 'function' — a command's `main`, waiting for a context
 * ```
 */
export function whereWeAre(name: string): ReplCommand['main'] {
  return selecting(name, { step: 0, counted: false });
}

/** One step out of the line, whichever of the three ways gdb named. */
function stepping(name: string, kind: Repl.StepKind): ReplCommand['main'] {
  return async (repl, argument) => {
    const times = asCount(argument);
    if (times === null) return repl.log(`Usage: .${name} [count]`);
    if (!repl.session.pausedAt) return repl.log('Not paused');

    // Only where it ends up is printed. A count means "do this n times", and n locations on the
    // way is the noise you asked to skip by giving one.
    const where = await repeat(times, () => repl.session.step(kind));
    if (where === null) return repl.log(blue('the page carried on'));
    repl.log(blue(where));
    await showFrame(repl);
  };
}

/**
 * Picking a frame to read: `step` is how far and which way, `counted` whether an argument is one.
 *
 * `step` is gdb's direction — `1` toward whoever called this, `-1` back toward where it stopped,
 * `0` for "the argument is a frame number, not a distance".
 */
function selecting(
  name: string,
  { step, counted }: { step: number; counted: boolean },
): ReplCommand['main'] {
  return async (repl, argument) => {
    if (!repl.session.pausedAt) return repl.log('Not paused');
    const here = repl.session.backtrace().find((frame) => frame.selected)?.index ?? 0;
    if (!counted && argument.trim() !== '') return repl.log(`Usage: .${name}`);

    const given = asCount(argument, step === 0 ? here : 1);
    if (given === null) {
      return repl.log(`Usage: .${name} ${step === 0 ? '[number]' : '[count]'}`);
    }
    // A direction times a count, or the number itself. `up -1` is `down 1`, as in gdb.
    const where = repl.session.selectFrame(step === 0 ? given : here + step * given);
    if (where === null) return repl.log(red('No such frame'));

    repl.log(blue(where));
    await showFrame(repl);
  };
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
