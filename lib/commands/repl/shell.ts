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
 * Streamed rather than collected: a command worth running from here is often one worth watching,
 * and a build that prints for a minute should print for a minute.
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
    const child = spawn(trimmed, { shell: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk: Buffer) => out.write(chunk));
    child.stderr.on('data', (chunk: Buffer) => out.write(chunk));
    // A command that will not start is an answer about the command, not a crash of the session.
    child.on('error', (error: Error) => {
      out.write(red(`${error.message}\n`));
      resolve(127);
    });
    child.on('close', (code) => resolve(code ?? 0));
  });
}
