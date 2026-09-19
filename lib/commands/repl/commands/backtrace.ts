import { frameTable } from '../frames.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.backtrace` — the call stack, newest first, numbered from where it stopped.
 *
 * A breakpoint is rarely only about the line it stopped on — the answer is as often in who called
 * it — and gdb's names for looking are the ones anybody who has used a debugger already has.
 *
 * ```ts
 * import { command as backtraceCommand } from './backtrace.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return backtraceCommand.main(repl, '3'); // the innermost three frames
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Show the call stack — `.backtrace 3` for the innermost three',
  aliases: ['bt', 'where'],
  main(repl, argument) {
    // Nothing after it is the whole stack, which is what a backtrace is usually asked for. The
    // check is on what was TYPED rather than on `wanted`, because `Number.isInteger(Infinity)` is
    // false and a bare `.backtrace` would otherwise answer with its own usage line.
    const typed = argument.trim();
    const wanted = typed === '' ? Infinity : Number(typed);
    if (typed !== '' && !Number.isInteger(wanted)) {
      repl.log('Usage: .backtrace [count]');

      return;
    }
    const frames = repl.session.backtrace();
    repl.log(
      frames.length === 0 ? 'Not paused' : frameTable(frames.slice(0, wanted), repl.palette),
    );
  },
};
