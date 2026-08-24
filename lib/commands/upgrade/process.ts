import { spawn as spawnChild } from 'node:child_process';

/**
 * How the installer this process ran finished — shaped like the process it describes.
 *
 * `exitCode` and `signalCode` are the two `ChildProcess` carries after it closes, and they mean
 * the same here: a process that exits has a code and no signal, one that is killed has a signal
 * and no code. Keeping both spellings means a caller never has to translate this back into what
 * really happened before reporting it.
 */
export interface SpawnResult {
  /** The installer's exit code. Null when a signal killed it, or when it never started. */
  exitCode: number | null;
  /** The signal that killed it, or null when it exited on its own. */
  signalCode: NodeJS.Signals | null;
  /**
   * True when the installer is not on PATH at all — `deno` on a machine without deno.
   *
   * Its own field rather than an error, because it is the one outcome that is not a failure of the
   * upgrade: nothing ran, nothing broke, and printing the command really is the best answer left.
   */
  isMissingInstallerBinary: boolean;
}

/**
 * Runs another tool's installer — `deno install`, `npm install -g` — and reports how it went.
 *
 * `upgrade` owns the standalone binary and replaces it itself. Every other user-level install is
 * owned by the tool that made it, and the honest way to upgrade one is to ask that tool, which is
 * what this does. The alternative, printing the line for someone to paste, is a worse version of
 * the same command: it knows the answer and makes the user do it.
 *
 * Stdio is inherited, so the installer's own progress and errors reach the terminal unfiltered.
 * There is no shell: argv is passed through as given, so a version string can never be word-split
 * or glob-expanded on its way to the installer.
 *
 * Never rejects. A missing installer and a failing one are both answers about the upgrade rather
 * than bugs in it, so both come back as a value the caller reports.
 *
 * ```ts
 * import * as Process from './process.ts';
 *
 * // Defined, not invoked: spawns a real installer.
 * async function upgradeViaDeno() {
 *   const { exitCode, isMissingInstallerBinary } = await Process.spawn([
 *     'deno', 'install', '-Agf', 'jsr:@izelnakri/qunitx-cli@1.0.0',
 *   ]);
 *   return isMissingInstallerBinary ? 'deno is not installed' : `exited ${exitCode}`;
 * }
 * ```
 */
export function spawn(argv: string[]): Promise<SpawnResult> {
  const [bin, ...args] = argv;

  return new Promise((resolve) => {
    // `shell: false` is the default and the point: nothing here is ever parsed by a shell, so a
    // version that arrived from argv cannot become one.
    const child = spawnChild(bin, args, { stdio: 'inherit' });

    // ENOENT means the tool is not installed; anything else is a real spawn failure. Both leave
    // the caller with the same fallback, so they answer the same way.
    child.on('error', (error: NodeJS.ErrnoException) => {
      resolve({
        exitCode: null,
        signalCode: null,
        isMissingInstallerBinary: error.code === 'ENOENT',
      });
    });
    child.on('close', (exitCode, signalCode) => {
      resolve({ exitCode, signalCode, isMissingInstallerBinary: false });
    });
  });
}
