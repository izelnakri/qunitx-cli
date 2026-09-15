import { asCount } from '../command.ts';
import { frameList } from '../frames.ts';
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
    const wanted = asCount(argument, Infinity);
    if (wanted === null) {
      repl.log('Usage: .backtrace [count]');

      return;
    }
    const frames = repl.session.backtrace();
    repl.log(frames.length === 0 ? 'Not paused' : frameList(frames.slice(0, wanted), repl.palette));
  },
};
