import { count, stack } from '../debugging.ts';
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
 * backtraceCommand.aliases; // ['bt', 'where'] — the same command under the names a hand reaches for
 * ```
 */
export const command: ReplCommand = {
  description: 'Show the call stack — `.backtrace 3` for the innermost three',
  aliases: ['bt', 'where'],
  main: (repl, argument) => {
    const wanted = count(argument, Infinity);
    if (wanted === null) {
      repl.write('Usage: .backtrace [count]\n');

      return repl.prompt();
    }
    const frames = repl.session.backtrace();
    repl.write(
      frames.length === 0 ? 'Not paused\n' : `${stack(frames.slice(0, wanted), repl.palette)}\n`,
    );
    repl.prompt();
  },
};
