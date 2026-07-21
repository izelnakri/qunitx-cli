import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/**
 * Returns the per-cwd path the daemon listens on. Platform-specific:
 *
 * - POSIX: a Unix domain socket file under `os.tmpdir()` (`/tmp/qunitx-daemon-<hash>.sock`).
 * - Windows: a named pipe under the special `\\.\pipe\` namespace
 *   (`\\.\pipe\qunitx-daemon-<hash>`). Node maps `net.Server.listen(pipePath)` to a
 *   Win32 named pipe; a regular tmpdir filesystem path silently fails to bind.
 *
 * `platform` is parameterized for testability; it defaults to `process.platform`.
 */
export function socket(
  cwd: string = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): string {
  const name = `qunitx-daemon-${cwdHash(cwd)}`;
  if (platform === 'win32') return `\\\\.\\pipe\\${name}`;
  return path.join(os.tmpdir(), `${name}.sock`);
}

/**
 * Returns the per-cwd subdirectory that holds the daemon's info file, lockfile,
 * and any future per-daemon state.
 *
 * Why a subdirectory instead of files directly under os.tmpdir():
 * the client's `waitForFile` (see lib/commands/daemon/index.ts) calls
 * `fs.watch(path.dirname(info()))` to detect daemon-readiness.
 * On Windows, `fs.watch` on `os.tmpdir()` itself crashes the process with
 * `Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72`
 * (libuv exit code 3221226505 / STATUS_STACK_BUFFER_OVERRUN) when concurrent
 * tests churn the system temp root with unrelated file events whose absolute
 * paths don't case-insensitively start with the watched dir prefix —
 * reproducible on hosted windows-latest under the test (windows-latest) lane.
 *
 * Giving the daemon its own small private directory keeps watch traffic to
 * events the watcher actually cares about and sidesteps the libuv wart.
 */
export function dir(cwd: string = process.cwd()): string {
  return path.join(os.tmpdir(), `qunitx-daemon-${cwdHash(cwd)}`);
}

/**
 * Returns the per-cwd sidecar JSON path that mirrors the daemon's socket. Lets
 * `daemon status` introspect daemon identity (pid, node version, uptime) without
 * an IPC roundtrip, and serves as the cross-platform "is a daemon present?" sentinel
 * since Windows named pipes are not visible on the regular filesystem.
 *
 * Lives inside `dir(cwd)` rather than directly under os.tmpdir() — see
 * `dir` for the Windows-fs.watch crash this avoids.
 */
export function info(cwd: string = process.cwd()): string {
  return path.join(dir(cwd), 'info.json');
}

// Socket path is derived from the cwd hash so each project gets its own daemon.
// Hash truncated to 12 hex chars: 48 bits, collision-resistant for the small set
// of cwds a developer machine ever uses simultaneously.
function cwdHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12);
}
