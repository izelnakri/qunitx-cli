import { writeSync } from 'node:fs';
import process from 'node:process';
import { tryCatch } from '../result/try.ts';

/** What {@link armExitGuard} hands back: the one way to say the work produced a result. */
export interface ExitGuard {
  /** The result is in — exit with this code, and stop treating an exit as unexplained. */
  reported(code: number): void;
}

/** The parts of `process` the guard touches, so a test can drive its exit without exiting. */
export interface ExitTarget {
  /** The code the process will exit with; assigning it is how the guard has its say. */
  exitCode?: number | string | null | undefined;
  /** Registers the `exit` listener — the last moment anything can still be said or decided. */
  on(event: 'exit', listener: () => void): unknown;
}

/**
 * Makes exiting 0 something a command has to say, rather than what happens when nothing is left to
 * do.
 *
 * Node exits 0 when its event loop goes quiet, which means every `await` in a command is also a
 * way to report success by accident: whatever it was waiting for never comes, the last handle
 * closes, and the process ends cleanly having done nothing. cli.ts has hit this often enough that
 * five separate comments in it say "set the exit code BEFORE this await" — a config failure that
 * printed nothing and exited 0, a search that found nothing and exited 0, a `qunitx repl
 * missing-file.ts` with empty stderr. This is that rule as a mechanism instead of a habit.
 *
 * Armed, the exit code is 1 until {@link ExitGuard.reported} sets it to what the work decided. An
 * exit that never got there is therefore a failure, and says so on stderr with whatever `describe`
 * knows about where the work had got to — because the failure it replaces (exit 0, no output) is
 * one nobody can debug from a CI log.
 *
 * ```ts
 * import { armExitGuard, type ExitTarget } from './exit-guard.ts';
 *
 * const said: string[] = [];
 * const target: ExitTarget = { exitCode: 0, on: () => {} };
 * const guard = armExitGuard(() => 'phase: running', target, (message) => said.push(message));
 *
 * target.exitCode; // 1 — until the work says otherwise
 * guard.reported(0);
 * target.exitCode; // 0
 * said.length; // 0 — nothing to explain
 * ```
 */
export function armExitGuard(
  describe: () => string,
  target: ExitTarget = process,
  write: (message: string) => void = toStderr,
): ExitGuard {
  let reported = false;
  target.exitCode = 1;

  target.on('exit', () => {
    if (reported) return;
    // Assigning here still decides the status — verified on both Node and Deno — so this covers
    // an exit code someone else set to 0 in between as well as the armed default.
    target.exitCode = 1;
    write(
      `# [qunitx] exiting 1: the run ended without reporting a result (${describe()}).\n` +
        `# [qunitx] Nothing was left for the process to do — a browser or a socket it was waiting on went away.\n`,
    );
  });

  return {
    reported(code: number): void {
      reported = true;
      target.exitCode = code;
    },
  };
}

/** `writeSync` because a queued async write to a pipe is lost at exit, and a closed fd is not fatal. */
function toStderr(message: string): void {
  tryCatch(() => writeSync(2, message));
}
