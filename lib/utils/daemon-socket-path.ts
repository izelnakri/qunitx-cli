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
 * Returns the per-cwd Unix socket path the daemon listens on. Same cwd → same path,
 * so any project gets at most one daemon regardless of how it is invoked.
 */
export function daemonSocketPath(cwd: string = process.cwd()): string {
  return path.join(os.tmpdir(), `qunitx-daemon-${cwdHash(cwd)}.sock`);
}

/**
 * Returns the per-cwd sidecar JSON path that mirrors the daemon's socket. Lets
 * `daemon status` introspect daemon identity (pid, node version, uptime) without
 * an IPC roundtrip.
 */
export function daemonInfoPath(cwd: string = process.cwd()): string {
  return path.join(os.tmpdir(), `qunitx-daemon-${cwdHash(cwd)}.json`);
}
