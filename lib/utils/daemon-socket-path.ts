import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// Socket path is derived from the cwd hash so each project gets its own daemon.
// Hash truncated to 12 hex chars: 48 bits, collision-resistant for the small set
// of cwds a developer machine ever uses simultaneously.
function cwdHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12);
}

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
export function daemonSocketPath(
  cwd: string = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): string {
  const name = `qunitx-daemon-${cwdHash(cwd)}`;
  if (platform === 'win32') return `\\\\.\\pipe\\${name}`;
  return path.join(os.tmpdir(), `${name}.sock`);
}

/**
 * Returns the per-cwd sidecar JSON path that mirrors the daemon's socket. Lets
 * `daemon status` introspect daemon identity (pid, node version, uptime) without
 * an IPC roundtrip, and serves as the cross-platform "is a daemon present?" sentinel
 * since Windows named pipes are not visible on the regular filesystem.
 */
export function daemonInfoPath(cwd: string = process.cwd()): string {
  return path.join(os.tmpdir(), `qunitx-daemon-${cwdHash(cwd)}.json`);
}
