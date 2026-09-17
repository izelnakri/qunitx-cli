import { excerpt, limits } from '../../repl/excerpt.ts';
import { inStyle } from '../../repl/terminal.ts';
import { asCount } from './command.ts';
import { blue, red } from '../../utils/color.ts';
import type * as Repl from '../../repl/session.ts';
import type { ReplContext } from './command.ts';
import type { Theme } from '../../repl/theme.ts';

// The seven frame commands. Every exported command function here has exactly the
// `ReplCommand['main']` signature, so a command file reads `main: stepIntoNextCall` and nothing
// else — no factory to go and open, and no argument that turns out to be the command's own name.

/**
 * The source around wherever the page is stopped, drawn under whatever announced the stop.
 *
 * ```ts
 * import { showFrameSource } from './frames.ts';
 *
 * import type { ReplContext } from './command.ts';
 *
 * // Defined, not invoked: it reads a stopped page.
 * function example(repl: ReplContext) {
 *   return showFrameSource(repl);
 * }
 * ```
 */
export async function showFrameSource(repl: ReplContext): Promise<void> {
  const frame = await repl.session.frameSource();
  const shown = frame ? excerpt(frame.text, frame.line, repl.palette, limits()) : '';
  if (shown !== '') repl.log(shown);
}

/**
 * The stack as gdb prints one: newest first, numbered from where it stopped, with a mark on the
 * frame being read. What `.backtrace` prints, and the sibling of `scopeTable`.
 *
 * ```ts
 * import { frameTable } from './frames.ts';
 *
 * const plain = { style: () => '' };
 * frameTable([{ index: 0, where: 'outer (a.ts:1:1)', selected: true }], plain);
 * // '> #0  outer (a.ts:1:1)'
 * ```
 */
export function frameTable(frames: readonly Repl.Frame[], palette: Theme): string {
  const dim = palette.style('LineNr');
  const mark = palette.style('@keyword');

  return frames
    .map(({ index, where, selected }) => {
      const number = `#${index}`;
      const edge = selected
        ? `${inStyle('>', mark)} ${inStyle(number, mark)}`
        : `  ${inStyle(number, dim)}`;

      return `${edge}  ${where}`;
    })
    .join('\n');
}

/**
 * `.step` — run one step, entering whatever this line calls. `.step 3` for three.
 *
 * Stepping is also the only way INTO another frame from a breakpoint: a `debugger` statement
 * inside something you CALL while stopped does nothing, because V8 disables breakpoints for the
 * duration of a debugger evaluation.
 *
 * ```ts
 * import { stepIntoNextCall } from './frames.ts';
 *
 * import type { ReplContext } from './command.ts';
 *
 * // Defined, not invoked: it drives a stopped page.
 * function example(repl: ReplContext) {
 *   return stepIntoNextCall(repl, '3'); // three steps, then where that left it
 * }
 * ```
 */
export function stepIntoNextCall(repl: ReplContext, argument: string): Promise<void> {
  return takeSteps(repl, argument, { command: 'step', kind: 'into' });
}

/**
 * `.next` — run one step, letting the next call run rather than entering it.
 *
 * ```ts
 * import { stepOverNextCall } from './frames.ts';
 *
 * import type { ReplContext } from './command.ts';
 *
 * // Defined, not invoked: it drives a stopped page.
 * function example(repl: ReplContext) {
 *   return stepOverNextCall(repl, ''); // once
 * }
 * ```
 */
export function stepOverNextCall(repl: ReplContext, argument: string): Promise<void> {
  return takeSteps(repl, argument, { command: 'next', kind: 'over' });
}

/**
 * `.finish` — run until this frame returns, and stop in whoever called it.
 *
 * ```ts
 * import { stepOutOfThisFrame } from './frames.ts';
 *
 * import type { ReplContext } from './command.ts';
 *
 * // Defined, not invoked: it drives a stopped page.
 * function example(repl: ReplContext) {
 *   return stepOutOfThisFrame(repl, ''); // out of one frame
 * }
 * ```
 */
export function stepOutOfThisFrame(repl: ReplContext, argument: string): Promise<void> {
  return takeSteps(repl, argument, { command: 'finish', kind: 'out' });
}

/**
 * `.up` — read the frame that called this one. `.up 2` for its caller's caller.
 *
 * Up the stack, which grows downwards: outward is where the caller is. Nothing RUNS — this only
 * changes which frame the rest of the session reads, which is what separates it from `.finish`.
 *
 * ```ts
 * import { goToCallerFrame } from './frames.ts';
 *
 * import type { ReplContext } from './command.ts';
 *
 * // Defined, not invoked: it reads a stopped page.
 * function example(repl: ReplContext) {
 *   return goToCallerFrame(repl, '2'); // two frames outward
 * }
 * ```
 */
export function goToCallerFrame(repl: ReplContext, argument: string): Promise<void> {
  return selectFrame(repl, argument, { command: 'up', move: 'toward-caller' });
}

/**
 * `.back` — the same move as `.up`, under the word a hand reaches for.
 *
 * The caller ran BEFORE the frame it called, so back in execution order IS outward. gdb spells
 * `back` as an abbreviation of `backtrace`, which is its prefix-matching rather than its
 * judgement, and reads wrong at a prompt where somebody typing "back" means "take me back".
 *
 * Its own function rather than `goToCallerFrame` with a spelling passed in, so that every command
 * in this file stays a plain `main` that takes only what a command is given. There is
 * deliberately no `.prev`: a third word for one move invites a `.next` to answer it, which is
 * already the step-over command.
 *
 * ```ts
 * import { goBackToCallerFrame } from './frames.ts';
 *
 * import type { ReplContext } from './command.ts';
 *
 * // Defined, not invoked: it reads a stopped page.
 * function example(repl: ReplContext) {
 *   return goBackToCallerFrame(repl, '1'); // one frame back, which is one frame out
 * }
 * ```
 */
export function goBackToCallerFrame(repl: ReplContext, argument: string): Promise<void> {
  return selectFrame(repl, argument, { command: 'back', move: 'toward-caller' });
}

/**
 * `.down` — read the frame this one called, back toward where the page actually stopped.
 *
 * ```ts
 * import { goToCalleeFrame } from './frames.ts';
 *
 * import type { ReplContext } from './command.ts';
 *
 * // Defined, not invoked: it reads a stopped page.
 * function example(repl: ReplContext) {
 *   return goToCalleeFrame(repl, '1'); // one frame inward
 * }
 * ```
 */
export function goToCalleeFrame(repl: ReplContext, argument: string): Promise<void> {
  return selectFrame(repl, argument, { command: 'down', move: 'toward-callee' });
}

/**
 * `.frame 1` — read a frame by its number, counting from where the page stopped.
 *
 * Bare it moves nowhere, which is what gdb's does — and what stops it meaning "go to frame 0",
 * since `Number('')` is zero.
 *
 * ```ts
 * import { goToFrameNumber } from './frames.ts';
 *
 * import type { ReplContext } from './command.ts';
 *
 * // Defined, not invoked: it reads a stopped page.
 * function example(repl: ReplContext) {
 *   return goToFrameNumber(repl, '1'); // frame #1, wherever the selection was before
 * }
 * ```
 */
export function goToFrameNumber(repl: ReplContext, argument: string): Promise<void> {
  return selectFrame(repl, argument, { command: 'frame', move: 'to-number' });
}

/**
 * `.here` — say which frame is being read, and go nowhere.
 *
 * It asks one question and takes nothing to answer it. Reading an argument and moving somewhere
 * would be the command doing what its name does not say, so an argument is a usage error.
 *
 * ```ts
 * import { sayWhichFrame } from './frames.ts';
 *
 * import type { ReplContext } from './command.ts';
 *
 * // Defined, not invoked: it reads a stopped page.
 * function example(repl: ReplContext) {
 *   return sayWhichFrame(repl, ''); // where you are, having gone nowhere
 * }
 * ```
 */
export function sayWhichFrame(repl: ReplContext, argument: string): Promise<void> {
  return selectFrame(repl, argument, { command: 'here', move: 'nowhere' });
}

/**
 * Which frame to read next, and what the argument after the command means.
 *
 * Spelled out rather than passed as a direction number and a boolean: `{ step: 1, counted: true }`
 * needed this file open to mean anything, and the four commands read their argument as three
 * genuinely different things.
 */
type FrameChoice = {
  /** The command's own spelling, for the usage line it prints when the argument is wrong. */
  command: string;
  /**
   * `toward-caller` and `toward-callee` read the argument as a DISTANCE from the frame being
   * read; `to-number` reads it as an absolute frame NUMBER; `nowhere` takes no argument at all.
   */
  move: 'toward-caller' | 'toward-callee' | 'to-number' | 'nowhere';
};

/** Runs `n` steps of one kind, then says where the page ended up and shows that line. */
async function takeSteps(
  repl: ReplContext,
  argument: string,
  { command, kind }: { command: string; kind: Repl.StepKind },
): Promise<void> {
  const times = asCount(argument);
  if (times === null) return repl.log(`Usage: .${command} [count]`);
  if (!repl.session.pausedAt) return repl.log('Not paused');

  // Only where it ends up is printed. A count means "do this n times", and n locations on the
  // way is the noise you asked to skip by giving one.
  const where = await repeat(times, () => repl.session.step(kind));
  if (where === null) return repl.log(blue('the page carried on'));
  repl.log(blue(where));
  await showFrameSource(repl);
}

/** Points the session at another frame of the stopped stack, and shows the line it is on. */
async function selectFrame(
  repl: ReplContext,
  argument: string,
  { command, move }: FrameChoice,
): Promise<void> {
  if (!repl.session.pausedAt) return repl.log('Not paused');
  const here = repl.session.backtrace().find((frame) => frame.selected)?.index ?? 0;
  if (move === 'nowhere' && argument.trim() !== '') return repl.log(`Usage: .${command}`);

  // `.frame` and `.here` are about a frame number, and default to the one already being read;
  // `.up` and `.down` are about a distance, and default to one of them.
  const byNumber = move === 'to-number' || move === 'nowhere';
  const given = asCount(argument, byNumber ? here : 1);
  if (given === null) {
    return repl.log(`Usage: .${command} ${move === 'to-number' ? '[number]' : '[count]'}`);
  }
  // A distance times a direction, or the number itself. `.up -1` is `.down 1`, as in gdb.
  const outward = move === 'toward-caller' ? 1 : -1;
  const wanted = byNumber ? given : here + outward * given;
  const where = repl.session.selectFrame(wanted);
  if (where === null) return repl.log(red('No such frame'));

  repl.log(blue(where));
  await showFrameSource(repl);
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
