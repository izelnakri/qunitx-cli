import { realpathSync } from 'node:fs';

/**
 * `process.execPath` with symlinks resolved: the binary itself, wherever it was linked from.
 *
 * install.sh links `~/.local/bin/qunitx` to the binary in `~/.qunitx`. Linux reports the target,
 * but macOS can report the link, and then the esbuild sidecar was looked for beside the link and
 * `qunitx upgrade` replaced the link instead of the binary. Falls back to `execPath` as given.
 *
 * ```ts
 * import { realExecPath } from './real-exec-path.ts';
 *
 * realExecPath(); // e.g. '/home/me/.qunitx/qunitx', or the node/deno running this
 * ```
 */
export function realExecPath(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}
