import process from 'node:process';
import { paint, terminalWidth } from '../../repl/columns.ts';
import { excerpt, limits } from '../../repl/excerpt.ts';
import type { REPLServer } from 'node:repl';
import type * as Repl from '../../repl/session.ts';
import type { ReplSession } from '../../repl/session.ts';
import type { Theme } from '../../repl/theme.ts';
import { blue, red } from '../../utils/color.ts';
import { formatScope } from '../../repl/scope.ts';

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
 * import { defineDebugging } from './debugging.ts';
 *
 * import type { REPLServer } from 'node:repl';
 * import type { ReplSession } from '../../repl/session.ts';
 * import type { Theme } from '../../repl/theme.ts';
 *
 * // Defined, not invoked: it needs a live prompt and a live page.
 * function example(server: REPLServer, session: ReplSession, palette: Theme) {
 *   defineDebugging(server, session, palette);
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
const FRAMES: ReadonlyArray<{
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
function count(argument: string, fallback: number = 1): number | null {
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

/** The stack as gdb prints one: newest first, numbered from where it stopped. */
function stack(frames: readonly Repl.Frame[], palette: Theme): string {
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

/** The three ways out of a line, under the names gdb gave them. */
const STEPS: ReadonlyArray<[string, Repl.StepKind, string]> = [
  ['step', 'into', 'Run one step, entering the next call'],
  ['s', 'into', 'Run one step, entering the next call'],
  ['next', 'over', 'Run one step, over the next call rather than into it'],
  ['n', 'over', 'Run one step, over the next call rather than into it'],
  ['finish', 'out', 'Run until the current frame returns'],
];

/**
 * Every command a stopped page answers: moving through it, moving about its stack, and the
 * breakpoints that stop it in the first place.
 *
 * Defined beside the things only they use — the step names, the frame directions, the counts they
 * take — because a command and its own helpers belong in one file.
 *
 * ```ts
 * import { defineDebugging } from './debugging.ts';
 *
 * import type { REPLServer } from 'node:repl';
 * import type { ReplSession } from '../../repl/session.ts';
 * import type { Theme } from '../../repl/theme.ts';
 *
 * // Defined, not invoked: it needs a live prompt and a live page.
 * function example(server: REPLServer, session: ReplSession, palette: Theme) {
 *   defineDebugging(server, session, palette);
 * }
 * ```
 */
export function defineDebugging(server: REPLServer, session: ReplSession, palette: Theme): void {
  server.defineCommand('breakpoints', {
    help: 'List the breakpoints this session has set',
    action() {
      this.clearBufferedCommand();
      const set = session.breakpoints();
      this.output.write(
        set.length === 0
          ? 'No breakpoints\n'
          : `${set.map(({ index, where }) => `${index}  ${where}`).join('\n')}\n`,
      );
      this.displayPrompt();
    },
  });
  server.defineCommand('delete', {
    help: 'Remove a breakpoint by its number — `.delete 1`',
    action(argument: string) {
      this.clearBufferedCommand();
      const index = count(argument, 0);
      // No number is not "all of them". Deleting everything by accident is a worse mistake than
      // typing one more character, and there is no confirmation here to catch it.
      if (index === null || index < 1) {
        this.output.write(`Usage: .delete <number>\n`);

        return void this.displayPrompt();
      }
      void session.removeBreakpoint(index).then((removed) => {
        if (!removed) this.output.write(red(`No breakpoint ${index}\n`));
        this.displayPrompt();
      });
    },
  });
  // `.continue` is the name every debugger uses for this, and the one the pause itself offers.
  // `.resume` stays because it is what this REPL shipped with, and a command that used to work
  // should not stop working over a rename.
  // `.c` because that is what it is in gdb, and what the hand types after the fifth breakpoint.
  for (const name of ['continue', 'c', 'resume']) {
    server.defineCommand(name, {
      help: 'Let a page paused at a `debugger` statement carry on',
      action() {
        this.clearBufferedCommand();
        if (!session.pausedAt) this.output.write('Not paused\n');
        void session.resume().then(() => this.displayPrompt());
      },
    });
  }
  // `step`, `next` and `finish`, as every debugger since gdb has named them. Stepping is also
  // the only way into another frame from a breakpoint: a `debugger` statement inside something
  // you CALL while stopped does nothing, because V8 turns breakpoints off for the length of a
  // debugger evaluation.
  for (const [name, kind, help] of STEPS) {
    server.defineCommand(name, {
      help,
      action(argument: string) {
        this.clearBufferedCommand();
        const times = count(argument);
        if (times === null) {
          this.output.write(`Usage: .${name} [count]\n`);

          return void this.displayPrompt();
        }
        if (!session.pausedAt) {
          this.output.write('Not paused\n');

          return void this.displayPrompt();
        }
        // Only where it ends up is printed. A count means "do this n times", and n locations on
        // the way is the noise you asked to skip by giving one.
        void repeat(times, () => session.step(kind)).then(async (where) => {
          if (where === null) this.output.write(blue('the page carried on\n'));
          else {
            this.output.write(blue(`${where}\n`));
            await showFrame(server, session, palette);
          }
          this.displayPrompt();
        });
      },
    });
  }
  // The stack, and where on it to stand. A breakpoint is rarely only about the line it stopped
  // on — the answer is as often in who called it — and gdb's names for looking are the ones
  // anybody who has used a debugger already has in their hands.
  for (const name of ['backtrace', 'bt', 'where']) {
    server.defineCommand(name, {
      help: 'Show the call stack — `.backtrace 3` for the innermost three',
      action(argument: string) {
        this.clearBufferedCommand();
        const wanted = count(argument, Infinity);
        if (wanted === null) {
          this.output.write(`Usage: .${name} [count]\n`);

          return void this.displayPrompt();
        }
        const frames = session.backtrace();
        const shown = frames.slice(0, wanted);
        this.output.write(frames.length === 0 ? 'Not paused\n' : `${stack(shown, palette)}\n`);
        this.displayPrompt();
      },
    });
  }
  // `up` toward whoever called this, `down` back toward where it stopped — gdb's directions,
  // which are about the stack growing downwards rather than about the list on screen.
  const move = (to: number) => {
    const where = session.selectFrame(to);
    if (where === null) server.output.write(red('No such frame\n'));

    return where;
  };
  for (const { name, direction, count: counted, help } of FRAMES) {
    server.defineCommand(name, {
      help,
      action(argument: string) {
        this.clearBufferedCommand();
        if (!session.pausedAt) {
          this.output.write('Not paused\n');

          return void this.displayPrompt();
        }
        const here = session.backtrace().find((frame) => frame.selected)?.index ?? 0;
        // `.here` asks one question and takes nothing to answer it. Reading an argument and
        // moving somewhere would be the command doing what its name does not say.
        if (!counted && argument.trim() !== '') {
          this.output.write(`Usage: .${name}\n`);

          return void this.displayPrompt();
        }
        // `.frame` with nothing after it says where you are without moving, which is what gdb's
        // does — and what stops it from meaning "go to frame 0" because `Number('')` is zero.
        const given = count(argument, direction === 0 ? here : 1);
        if (given === null) {
          this.output.write(`Usage: .${name} ${direction === 0 ? '[number]' : '[count]'}\n`);

          return void this.displayPrompt();
        }
        // A direction times a count, or the number itself. `up -1` is `down 1`, as in gdb.
        const asked = direction === 0 ? given : here + direction * given;
        const where = move(asked);
        if (where === null) return void this.displayPrompt();

        this.output.write(blue(`${where}\n`));
        void showFrame(server, session, palette).then(() => this.displayPrompt());
      },
    });
  }
  // Two commands rather than one because a REPL is in one of two states and the answer differs:
  // running, where the interesting names are the ones this session added to the page, and
  // stopped at a breakpoint, where they are the ones the frame can see. Same format either way.
  server.defineCommand('scope', {
    help: 'List what this session has added to the page, with values',
    action() {
      this.clearBufferedCommand();
      void session.scope().then((entries) => {
        const listing = formatScope(entries, terminalWidth(this.output));
        this.output.write(listing === '' ? 'Nothing declared yet\n' : `${listing}\n`);
        this.displayPrompt();
      });
    },
  });
  server.defineCommand('locals', {
    help: 'List what is in scope at a `debugger` breakpoint, with values',
    action() {
      this.clearBufferedCommand();
      if (!session.pausedAt) {
        this.output.write('Not paused — `.scope` is what this session has declared\n');

        return void this.displayPrompt();
      }
      void session.locals().then((entries) => {
        const listing = formatScope(entries, terminalWidth(this.output));
        this.output.write(listing === '' ? 'Nothing in scope here\n' : `${listing}\n`);
        this.displayPrompt();
      });
    },
  });
}
