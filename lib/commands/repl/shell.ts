import { spawn } from 'node:child_process';
import { red } from '../../utils/color.ts';

/**
 * Runs one shell command, streaming its output to the terminal as it arrives.
 *
 * Through a shell on purpose: `:` means "the thing I would have typed in another window", and
 * pipes, globs and `&&` are most of what that is. The command comes from the person at the prompt,
 * for their own machine — there is nothing here to protect them from that they could not type
 * directly. It runs in the session's working directory, so relative paths mean what `.cat` means.
 *
 * The child is handed this process's own stdout and stderr rather than a pipe copied across, which
 * is what makes `:git status` and `:ls` come out in colour: every tool decides whether to colour by
 * asking whether it is talking to a terminal, and a pipe answers no. It is also what makes a
 * progress bar work, and what keeps a build that prints for a minute printing for a minute rather
 * than arriving at the end. Piped in, piped out — a scripted session still gets plain text, for the
 * same reason and by the same rule.
 *
 * `out` is left for the one message that is this REPL's rather than the command's: a command that
 * will not start at all.
 *
 * ```ts
 * import { shell } from './shell.ts';
 *
 * // Defined, not invoked: it starts a real process.
 * function example(out: NodeJS.WritableStream) {
 *   return shell('git status --short', out, process.cwd()); // resolves with the exit code
 * }
 * ```
 */
export function shell(command: string, out: NodeJS.WritableStream, cwd: string): Promise<number> {
  const trimmed = command.trim();
  if (trimmed === '') return Promise.resolve(0);

  return new Promise((resolve) => {
    // stdin stays closed: the terminal's is being read by the prompt, and two readers of one
    // keyboard is a session that loses keystrokes. `.edit` is the way to hand a command the tty.
    const child = spawn(trimmed, { shell: true, cwd, stdio: ['ignore', 'inherit', 'inherit'] });
    // A command that will not start is an answer about the command, not a crash of the session.
    child.on('error', (error: Error) => {
      out.write(red(`${error.message}\n`));
      resolve(127);
    });
    child.on('close', (code) => resolve(code ?? 0));
  });
}
