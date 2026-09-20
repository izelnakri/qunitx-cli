import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs';

/** Where a session's history is kept, beside every other tool's dotfile. */
const HISTORY_FILE = '.qunitx_repl_history';
import type { REPLServer } from 'node:repl';

/**
 * Points history at `~/.qunitx_repl_history`, honouring `QUNITX_REPL_HISTORY` (an empty value
 * turns it off). Only in a terminal — `setupHistory` is a no-op without one, and a scripted
 * invocation has no business writing to a history file.
 *
 * ```ts
 * import { setupHistory } from './history.ts';
 *
 * import type { REPLServer } from 'node:repl';
 *
 * // Defined, not invoked: it opens a file in the developer's home directory.
 * function example(server: REPLServer) {
 *   setupHistory(server, false); // a pipe keeps no history
 * }
 * ```
 */
export function setupHistory(server: REPLServer, interactive: boolean): void {
  const configured = process.env.QUNITX_REPL_HISTORY;
  if (!interactive || configured === '') return;
  const file = configured || path.join(os.homedir(), HISTORY_FILE);
  // A history file that cannot be written is worth knowing about, not worth refusing to start
  // over, and never worth a stack trace on top of the banner.
  server.setupHistory(file, (error) => {
    if (error) server.output.write(`# qunitx repl: history disabled (${error.message})\n`);
  });
  // `node:repl` writes the whole history at position 0 and never shortens the file, so a write
  // that is smaller than the one before it leaves the tail of the old one behind. The file is
  // newest first, so that tail lands on the END of the oldest entry and becomes part of it —
  // which is how a history line grows into `.localsstring()nan() { … }orle(4) should be 9')))'`,
  // a dozen half-lines glued into one. It survives every restart, and it is offered as a
  // suggestion the moment you type anything it happens to start with.
  server.on('flushHistory', () => {
    trimHistoryFile(file, (server as unknown as { history?: string[] }).history ?? []);
  });
}

/**
 * Cuts the history file back to the history it is meant to hold.
 *
 * Only ever SHORTENS. Growing a file with `truncate` pads it with zero bytes, and a history file
 * full of NULs is a worse problem than the one this solves — so a file that is already the right
 * size, or somehow shorter, is left exactly as it is.
 *
 * Best-effort throughout: a history file is a convenience, and no failure to tidy one is worth
 * interrupting a session over.
 *
 * ```ts
 * import { trimHistoryFile } from './history.ts';
 *
 * trimHistoryFile('/nonexistent/history', ['a']); // does nothing, says nothing
 * ```
 */
export function trimHistoryFile(file: string, history: readonly string[]): void {
  const wanted = Buffer.byteLength(history.join('\n'), 'utf8');
  try {
    if (fs.statSync(file).size > wanted) fs.truncateSync(file, wanted);
  } catch {
    // Gone, unreadable, or not ours to tidy.
  }
}

/**
 * How many lines a session keeps. `node:repl` keeps thirty; a shell keeps thousands.
 *
 * ```ts
 * import { HISTORY_KEPT } from './history.ts';
 *
 * HISTORY_KEPT > 30; // true — thirty is fewer than `.history` can be asked for
 * ```
 */
export const HISTORY_KEPT = 1_000;
