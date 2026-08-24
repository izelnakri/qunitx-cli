import { spawn } from 'node:child_process';

/** What running another installer can tell us, beyond its exit code. */
export interface DelegateResult {
  /** The updater's exit code, or null when it could not be started at all. */
  code: number | null;
  /** Set when the updater is not installed, so the caller can print the command instead. */
  missing: boolean;
}

/**
 * Runs another tool's updater — `deno install`, `npm install -g` — and reports how it went.
 *
 * `upgrade` owns the standalone binary and replaces it itself. Every other user-level install is
 * owned by the tool that made it, and the honest way to upgrade one is to ask that tool, which is
 * what this does. The alternative, printing the line for someone to paste, is a worse version of
 * the same command: it knows the answer and makes the user do it.
 *
 * Stdio is inherited, so the updater's own progress and errors reach the terminal unfiltered.
 * There is no shell: argv is passed through as given, so a version string can never be word-split
 * or glob-expanded on its way to the installer.
 *
 * A missing updater is reported rather than thrown. `deno` not being on PATH is not a crash — it
 * is the one case where printing the command really is the best this command can do.
 *
 * ```ts
 * import { delegate } from './delegate.ts';
 *
 * // Defined, not invoked: spawns a real installer.
 * async function upgradeViaDeno() {
 *   const { code, missing } = await delegate(['deno', 'install', '-Agf', 'jsr:@izelnakri/qunitx-cli@1.0.0']);
 *   return missing ? 'deno is not installed' : `exited ${code}`;
 * }
 * ```
 */
export function delegate(argv: string[]): Promise<DelegateResult> {
  const [bin, ...args] = argv;

  return new Promise((resolve) => {
    // `shell: false` is the default and the point: nothing here is ever parsed by a shell, so a
    // version that arrived from argv cannot become one.
    const child = spawn(bin, args, { stdio: 'inherit' });

    // ENOENT means the tool is not installed; anything else is a real spawn failure. Both leave
    // the caller with the same fallback, so they answer the same way.
    child.on('error', (error: NodeJS.ErrnoException) => {
      resolve({ code: null, missing: error.code === 'ENOENT' });
    });
    child.on('close', (code) => resolve({ code, missing: false }));
  });
}
