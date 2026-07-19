import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Runs faster than this don't benefit enough from the daemon to justify the nag.
const FAST_RUN_THRESHOLD_MS = 500;

const HINT_TEXT =
  '\n\x1b[34mℹ\x1b[39m Tip: export QUNITX_DAEMON=1 for ~2× faster repeated runs ' +
  '(qunitx daemon --help)\n';

const DEFAULT_SENTINEL = path.join(os.homedir(), '.cache', 'qunitx', 'hint-shown');

/** Run context consumed by the daemon-hint eligibility check. */
export interface HintContext {
  /** Total wall-clock the run took, in ms. Used against the fast-run threshold. */
  durationMs: number;
  /** True if the run is `--watch` mode (manages its own browser lifecycle — bypass). */
  watch?: boolean;
  /** True if this is the daemon process itself running the work — never hint. */
  daemonMode?: boolean;
  /** Environment to inspect for opt-outs. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override TTY detection (defaults to `process.stderr.isTTY`). Used in tests. */
  isTTY?: boolean;
}

/** Side-effect injection points for `maybePrintDaemonHint` — testing seams. */
export interface PrintOpts {
  /** Sentinel-file path (defaults to `~/.cache/qunitx/hint-shown`). */
  sentinelPath?: string;
  /** Writer function (defaults to `process.stderr.write`). */
  write?: (text: string) => void;
}

/**
 * Pure check: returns true iff the run context permits the hint. Covers env-var
 * opt-outs, watch / daemon modes (own browser lifecycle), CI (auto-bypassed),
 * the fast-run threshold, and TTY presence. No filesystem access.
 */
export function shouldShowDaemonHint(ctx: HintContext): boolean {
  const env = ctx.env ?? process.env;
  if (ctx.watch) return false;
  if (ctx.daemonMode) return false;
  if (env.CI) return false;
  if (env.QUNITX_DAEMON) return false;
  if (env.QUNITX_NO_DAEMON) return false;
  if (env.QUNITX_HINT_SHOWN) return false;
  if (ctx.durationMs < FAST_RUN_THRESHOLD_MS) return false;
  if (ctx.isTTY === false) return false;
  if (ctx.isTTY === undefined && !process.stderr.isTTY) return false;
  return true;
}

/**
 * Prints the daemon-mode tip to stderr and creates a sentinel file so the tip is
 * shown at most once per machine — users who already know about the daemon
 * shouldn't be nagged. All filesystem I/O is best-effort: a sentinel-write
 * failure just means the hint shows again on the next eligible run.
 */
export async function maybePrintDaemonHint(ctx: HintContext, opts: PrintOpts = {}): Promise<void> {
  if (!shouldShowDaemonHint(ctx)) return;
  const sentinel = opts.sentinelPath ?? DEFAULT_SENTINEL;
  try {
    await fs.access(sentinel);
    return;
  } catch {
    // Sentinel not present — proceed with show + create.
  }
  (opts.write ?? ((t) => process.stderr.write(t)))(HINT_TEXT);
  try {
    await fs.mkdir(path.dirname(sentinel), { recursive: true });
    await fs.writeFile(sentinel, new Date().toISOString());
  } catch {
    // Best-effort.
  }
}
